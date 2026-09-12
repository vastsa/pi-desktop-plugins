"use strict";

// One-shot client for the local askpass broker created by ssh.js. Credentials
// arrive over a private local IPC endpoint and are never read from ssh's env.
const net = require("node:net");

const endpoint = process.env.PI_SSH_ASKPASS_ENDPOINT;
const token = process.env.PI_SSH_ASKPASS_TOKEN;
if (!endpoint || !token) process.exit(1);

const socket = net.createConnection(endpoint);
let output = "";
const timer = setTimeout(() => {
  process.exitCode = 1;
  socket.destroy();
}, 5000);

socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${token}\n`));
socket.on("data", (chunk) => {
  output += chunk;
  if (output.length > 4097) {
    process.exitCode = 1;
    socket.destroy();
  }
});
socket.on("end", () => process.stdout.write(output));
socket.on("error", () => {
  process.exitCode = 1;
});
socket.on("close", () => clearTimeout(timer));
