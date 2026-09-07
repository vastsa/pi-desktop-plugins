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

func consoleSize(cols, rows int) windows.Coord {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	return windows.Coord{X: int16(cols), Y: int16(rows)}
}

func makePipePair() (r, w windows.Handle, err error) {
	sa := &windows.SecurityAttributes{
		Length:        uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		InheritHandle: 1,
	}
	err = windows.CreatePipe(&r, &w, sa, 0)
	return
}

func looksLikeWindowsPath(shell string) bool {
	if strings.ContainsAny(shell, `/\`) {
		return true
	}
	return len(shell) > 1 && shell[1] == ':'
}

func startPty(req request) (*ptySession, error) {
	inR, inW, err := makePipePair()
	if err != nil {
		return nil, err
	}
	outR, outW, err := makePipePair()
	if err != nil {
		_ = windows.CloseHandle(inR)
		_ = windows.CloseHandle(inW)
		return nil, err
	}

	closeAllPipes := func() {
		_ = windows.CloseHandle(inR)
		_ = windows.CloseHandle(inW)
		_ = windows.CloseHandle(outR)
		_ = windows.CloseHandle(outW)
	}

	var hpc windows.Handle
	if err := windows.CreatePseudoConsole(consoleSize(req.Cols, req.Rows), inR, outW, 0, &hpc); err != nil {
		closeAllPipes()
		return nil, fmt.Errorf("CreatePseudoConsole: %w", err)
	}

	// ConPTY duplicates these; drop our copies so the master side sees EOF later.
	_ = windows.CloseHandle(inR)
	_ = windows.CloseHandle(outW)
	inR, outW = windows.InvalidHandle, windows.InvalidHandle
	_ = windows.SetHandleInformation(inW, windows.HANDLE_FLAG_INHERIT, 0)
	_ = windows.SetHandleInformation(outR, windows.HANDLE_FLAG_INHERIT, 0)

	closePC := func() {
		windows.ClosePseudoConsole(hpc)
		_ = windows.CloseHandle(inW)
		_ = windows.CloseHandle(outR)
	}

	attrList, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		closePC()
		return nil, err
	}
	// PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE takes the HPCON itself as lpValue
	// (Microsoft EchoCon, node-pty, charmbracelet/x). Passing &hpc leaves the
	// child unattached, so powershell.exe allocates a real console window
	// instead of talking through the pipes that feed the in-app xterm.
	if err := attrList.Update(
		windows.PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(hpc),
		unsafe.Sizeof(hpc),
	); err != nil {
		attrList.Delete()
		closePC()
		return nil, err
	}

	argv := append([]string{req.Shell}, req.Args...)
	cmdLine, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(argv))
	if err != nil {
		attrList.Delete()
		closePC()
		return nil, err
	}

	var appPtr *uint16
	if looksLikeWindowsPath(req.Shell) {
		appPtr, err = windows.UTF16PtrFromString(req.Shell)
		if err != nil {
			attrList.Delete()
			closePC()
			return nil, err
		}
	}

	var cwdPtr *uint16
	if strings.TrimSpace(req.Cwd) != "" {
		cwdPtr, err = windows.UTF16PtrFromString(req.Cwd)
		if err != nil {
			attrList.Delete()
			closePC()
			return nil, err
		}
	}

	var si windows.StartupInfoEx
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESTDHANDLES | windows.STARTF_USESHOWWINDOW
	si.ShowWindow = windows.SW_HIDE
	si.ProcThreadAttributeList = attrList.List()

	envUTF16 := envBlock(mergeEnv(os.Environ(), req.Env))
	var pi windows.ProcessInformation
	err = windows.CreateProcess(
		appPtr,
		cmdLine,
		nil,
		nil,
		false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_NO_WINDOW,
		&envUTF16[0],
		cwdPtr,
		&si.StartupInfo,
		&pi,
	)
	runtime.KeepAlive(envUTF16)
	runtime.KeepAlive(si)
	runtime.KeepAlive(attrList)
	runtime.KeepAlive(hpc)
	attrList.Delete()
	if err != nil {
		closePC()
		return nil, err
	}
	_ = windows.CloseHandle(pi.Thread)

	inFile := os.NewFile(uintptr(inW), "conpty-in")
	outFile := os.NewFile(uintptr(outR), "conpty-out")

	return &ptySession{
		reader: outFile,
		write:  inFile.Write,
		resize: func(c, r int) error {
			return windows.ResizePseudoConsole(hpc, consoleSize(c, r))
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
			windows.ClosePseudoConsole(hpc)
			_ = inFile.Close()
			_ = outFile.Close()
			_ = windows.CloseHandle(pi.Process)
		},
	}, nil
}
