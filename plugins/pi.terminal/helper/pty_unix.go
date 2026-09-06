//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

func startPty(req request) (*ptySession, error) {
	args := req.Args
	if args == nil {
		args = []string{}
	}
	cmd := exec.Command(req.Shell, args...)
	if req.Argv0 != "" {
		cmd.Args[0] = req.Argv0
	}
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	}
	cmd.Env = mergeEnv(os.Environ(), req.Env)
	cols, rows := req.Cols, req.Rows
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	file, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &ptySession{
		reader: file,
		write:  file.Write,
		resize: func(c, r int) error {
			if c <= 0 {
				c = 80
			}
			if r <= 0 {
				r = 24
			}
			return pty.Setsize(file, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
		},
		kill: func() error {
			if cmd.Process == nil {
				return nil
			}
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
			return cmd.Process.Kill()
		},
		wait: func() (int, error) {
			err := cmd.Wait()
			if err == nil {
				return 0, nil
			}
			if ee, ok := err.(*exec.ExitError); ok {
				return ee.ExitCode(), nil
			}
			return 1, err
		},
		close: func() { _ = file.Close() },
	}, nil
}
