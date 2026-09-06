package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"strings"
	"sync"
)

type request struct {
	Type  string            `json:"type"`
	ID    string            `json:"id"`
	Cols  int               `json:"cols"`
	Rows  int               `json:"rows"`
	Shell string            `json:"shell"`
	Args  []string          `json:"args"`
	Argv0 string            `json:"argv0"`
	Cwd   string            `json:"cwd"`
	Env   map[string]string `json:"env"`
	Data  string            `json:"data"`
}

type event struct {
	Type    string `json:"type"`
	ID      string `json:"id,omitempty"`
	Data    string `json:"data,omitempty"`
	Code    *int   `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

type ptySession struct {
	id     string
	reader io.Reader
	write  func([]byte) (int, error)
	resize func(cols, rows int) error
	kill   func() error
	wait   func() (int, error)
	close  func()
}

var (
	outMu    sync.Mutex
	enc      = json.NewEncoder(os.Stdout)
	sessions = map[string]*ptySession{}
	sessMu   sync.Mutex
)

func send(ev event) {
	outMu.Lock()
	defer outMu.Unlock()
	_ = enc.Encode(ev)
}

func mergeEnv(base []string, overlay map[string]string) []string {
	env := make(map[string]string, len(base)+8)
	for _, item := range base {
		key, value, ok := strings.Cut(item, "=")
		if !ok || key == "" {
			continue
		}
		if strings.HasPrefix(key, "ELECTRON_") || strings.HasPrefix(key, "VSCODE_") || strings.HasPrefix(key, "CHROME_") {
			continue
		}
		env[key] = value
	}
	delete(env, "ELECTRON_RUN_AS_NODE")
	env["TERM"] = "xterm-256color"
	env["COLORTERM"] = "truecolor"
	for key, value := range overlay {
		if key == "" {
			continue
		}
		env[key] = value
	}
	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}

func attach(sess *ptySession) {
	go func() {
		buf := make([]byte, 32*1024)
		for {
			n, err := sess.reader.Read(buf)
			if n > 0 {
				send(event{
					Type: "data",
					ID:   sess.id,
					Data: base64.StdEncoding.EncodeToString(buf[:n]),
				})
			}
			if err != nil {
				code := 0
				if waitCode, waitErr := sess.wait(); waitErr == nil {
					code = waitCode
				} else if n == 0 {
					code = 1
				}
				send(event{Type: "exit", ID: sess.id, Code: &code})
				sess.close()
				sessMu.Lock()
				delete(sessions, sess.id)
				sessMu.Unlock()
				return
			}
		}
	}()
}

func handle(req request) {
	switch req.Type {
	case "spawn":
		if req.ID == "" || req.Shell == "" {
			send(event{Type: "error", ID: req.ID, Message: "spawn requires id and shell"})
			return
		}
		sessMu.Lock()
		if _, exists := sessions[req.ID]; exists {
			sessMu.Unlock()
			send(event{Type: "error", ID: req.ID, Message: "session already exists"})
			return
		}
		sessMu.Unlock()
		sess, err := startPty(req)
		if err != nil {
			send(event{Type: "error", ID: req.ID, Message: err.Error()})
			return
		}
		sess.id = req.ID
		sessMu.Lock()
		sessions[req.ID] = sess
		sessMu.Unlock()
		attach(sess)
	case "write":
		raw, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil {
			send(event{Type: "error", ID: req.ID, Message: "invalid base64 data"})
			return
		}
		sessMu.Lock()
		sess := sessions[req.ID]
		sessMu.Unlock()
		if sess == nil {
			send(event{Type: "error", ID: req.ID, Message: "unknown session"})
			return
		}
		if _, err := sess.write(raw); err != nil {
			send(event{Type: "error", ID: req.ID, Message: err.Error()})
		}
	case "resize":
		sessMu.Lock()
		sess := sessions[req.ID]
		sessMu.Unlock()
		if sess == nil {
			send(event{Type: "error", ID: req.ID, Message: "unknown session"})
			return
		}
		if err := sess.resize(req.Cols, req.Rows); err != nil {
			send(event{Type: "error", ID: req.ID, Message: err.Error()})
		}
	case "kill":
		sessMu.Lock()
		sess := sessions[req.ID]
		sessMu.Unlock()
		if sess == nil {
			return
		}
		_ = sess.kill()
	default:
		send(event{Type: "error", ID: req.ID, Message: "unknown request type"})
	}
}

func main() {
	enc.SetEscapeHTML(false)
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var req request
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			send(event{Type: "error", Message: "invalid json: " + err.Error()})
			continue
		}
		handle(req)
	}
	sessMu.Lock()
	live := make([]*ptySession, 0, len(sessions))
	for _, sess := range sessions {
		live = append(live, sess)
	}
	sessMu.Unlock()
	for _, sess := range live {
		_ = sess.kill()
		sess.close()
	}
}
