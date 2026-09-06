//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const procThreadAttributePseudoConsole = 0x00020016

var (
	kernel32              = windows.NewLazySystemDLL("kernel32.dll")
	createPseudoConsole   = kernel32.NewProc("CreatePseudoConsole")
	resizePseudoConsole   = kernel32.NewProc("ResizePseudoConsole")
	closePseudoConsole    = kernel32.NewProc("ClosePseudoConsole")
)

func coord(cols, rows int) uintptr {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return uintptr(uint32(uint16(cols)) | (uint32(uint16(rows)) << 16))
}

func envBlock(env []string) []uint16 {
	if len(env) == 0 {
		env = os.Environ()
	}
	var buf []uint16
	for _, item := range env {
		u, err := windows.UTF16FromString(item)
		if err != nil {
			continue
		}
		buf = append(buf, u...)
	}
	return append(buf, 0)
}

func startPty(req request) (*ptySession, error) {
	inR, inW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		_ = inR.Close()
		_ = inW.Close()
		return nil, err
	}

	var hpc windows.Handle
	r1, _, callErr := createPseudoConsole.Call(
		coord(req.Cols, req.Rows),
		inR.Fd(),
		outW.Fd(),
		0,
		uintptr(unsafe.Pointer(&hpc)),
	)
	if r1 != 0 {
		_ = inR.Close()
		_ = inW.Close()
		_ = outR.Close()
		_ = outW.Close()
		if callErr != nil {
			return nil, fmt.Errorf("CreatePseudoConsole: %w", callErr)
		}
		return nil, fmt.Errorf("CreatePseudoConsole HRESULT %d", r1)
	}

	_ = inR.Close()
	_ = outW.Close()

	attrList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		_, _, _ = closePseudoConsole.Call(uintptr(hpc))
		_ = inW.Close()
		_ = outR.Close()
		return nil, err
	}
	if err := attrList.Update(
		procThreadAttributePseudoConsole,
		unsafe.Pointer(&hpc),
		unsafe.Sizeof(hpc),
	); err != nil {
		attrList.Delete()
		_, _, _ = closePseudoConsole.Call(uintptr(hpc))
		_ = inW.Close()
		_ = outR.Close()
		return nil, err
	}

	argv := append([]string{req.Shell}, req.Args...)
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(argv))
	if err != nil {
		attrList.Delete()
		_, _, _ = closePseudoConsole.Call(uintptr(hpc))
		_ = inW.Close()
		_ = outR.Close()
		return nil, err
	}

	var cwdPtr *uint16
	if strings.TrimSpace(req.Cwd) != "" {
		cwdPtr, err = windows.UTF16PtrFromString(req.Cwd)
		if err != nil {
			attrList.Delete()
			_, _, _ = closePseudoConsole.Call(uintptr(hpc))
			_ = inW.Close()
			_ = outR.Close()
			return nil, err
		}
	}

	var si windows.StartupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	si.ProcThreadAttributeList = attrList.List()

	var pi windows.ProcessInformation
	envUTF16 := envBlock(mergeEnv(os.Environ(), req.Env))
	err = windows.CreateProcess(
		nil,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT,
		&envUTF16[0],
		cwdPtr,
		&si.StartupInfo,
		&pi,
	)
	runtime.KeepAlive(envUTF16)
	attrList.Delete()
	if err != nil {
		_, _, _ = closePseudoConsole.Call(uintptr(hpc))
		_ = inW.Close()
		_ = outR.Close()
		return nil, err
	}
	_ = windows.CloseHandle(pi.Thread)

	return &ptySession{
		reader: outR,
		write:  inW.Write,
		resize: func(c, r int) error {
			r1, _, callErr := resizePseudoConsole.Call(uintptr(hpc), coord(c, r))
			if r1 != 0 {
				if callErr != nil {
					return callErr
				}
				return fmt.Errorf("ResizePseudoConsole HRESULT %d", r1)
			}
			return nil
		},
		kill: func() error {
			return windows.TerminateProcess(pi.Process, 1)
		},
		wait: func() (int, error) {
			_, err := windows.WaitForSingleObject(pi.Process, windows.INFINITE)
			if err != nil {
				return 1, err
			}
			var code uint32
			if err := windows.GetExitCodeProcess(pi.Process, &code); err != nil {
				return 1, err
			}
			return int(code), nil
		},
		close: func() {
			_, _, _ = closePseudoConsole.Call(uintptr(hpc))
			_ = inW.Close()
			_ = outR.Close()
			_ = windows.CloseHandle(pi.Process)
		},
	}, nil
}
