#!/bin/sh
set -e
cd "$(dirname "$0")"
mkdir -p ../vendor
build() {
  echo "building $3"
  CGO_ENABLED=0 GOOS="$1" GOARCH="$2" go build -trimpath -ldflags="-s -w" -o "../vendor/$3" .
}
build darwin arm64 pi-pty-darwin-arm64
build darwin amd64 pi-pty-darwin-x64
build linux arm64 pi-pty-linux-arm64
build linux amd64 pi-pty-linux-x64
build windows arm64 pi-pty-win32-arm64.exe
build windows amd64 pi-pty-win32-x64.exe
ls -lh ../vendor
