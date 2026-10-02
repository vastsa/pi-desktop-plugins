/**
 * 验证 JasonYu0822/opencode2pi-desktop#3 那类 bug 在本插件里不存在。
 *
 * 那个 issue 说的是：代理为了过 Zen 匿名通道的门禁，对上游强制 stream:true，
 * 然后把 SSE 无脑管回客户端，于是发 stream:false 的客户端收到的是 data: 碎片。
 *
 * 本插件不需要那个 hack（上游是 BigModel Coding Plan，没有匿名通道门禁），
 * 所以请求体必须逐字节透传：宿主说 stream:false，上游就收到 stream:false，
 * 上游回单个 JSON，本插件就把单个 JSON 交回去。
 *
 * 跑法：node tests/passthrough.test.mjs
 */

import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('./main.js');
const { startService, stopService, state, setUpstream } = plugin._internals;

let pass = 0;
let fail = 0;
const chk = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name} ${detail}`); }
};

// 上游回显服务器：按收到的 stream 字段决定回单个 JSON 还是回 SSE。
let echo = null;
const echoServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 原样记下非 JSON 体 */ }
    echo = { raw, parsed, method: req.method, path: req.url };

    if (parsed && parsed.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const payload = JSON.stringify({ object: 'chat.completion', choices: [{ message: { content: '完整响应' } }] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
});
await new Promise((r) => echoServer.listen(0, '127.0.0.1', r));
setUpstream(`http://127.0.0.1:${echoServer.address().port}/v1/chat/completions`);

await startService({ log: () => {} });
const base = `http://127.0.0.1:${state.port}`;

const post = async (payload, headers = {}) => {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test', ...headers },
    body: JSON.stringify(payload),
  });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
};

console.log(`\n#3 核对：非流式客户端不能收到 SSE 碎片`);

// 1) 非流式：宿主说 stream:false，上游必须原样收到 false，客户端必须拿到单个 JSON
const nonStream = await post({
  model: 'GLM-5.3-Flash', max_tokens: 32, stream: false,
  messages: [{ role: 'user', content: 'hi' }],
});
chk('上游收到的 stream 字段是 false（没被强制改成 true）', echo?.parsed?.stream === false, `got ${echo?.parsed?.stream}`);
chk('请求体逐字节透传（未被改写）', echo?.raw === JSON.stringify({
  model: 'GLM-5.3-Flash', max_tokens: 32, stream: false,
  messages: [{ role: 'user', content: 'hi' }],
}));
chk('客户端拿到的是单个 JSON 对象', nonStream.text.startsWith('{') && nonStream.text.includes('chat.completion'), nonStream.text.slice(0, 80));
chk('响应 Content-Type 是 application/json', (nonStream.type || '').includes('application/json'), nonStream.type);
chk('响应里没有 data: 碎片', !nonStream.text.includes('data:'));

// 2) 不带 stream 字段：上游原样收到 undefined，仍回单个 JSON
const noStream = await post({ model: 'GLM-5.3-Flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
chk('省略 stream 时上游也没被塞进 stream', echo?.parsed?.stream === undefined, `got ${echo?.parsed?.stream}`);
chk('省略 stream 时客户端拿到的仍是单个 JSON', noStream.text.startsWith('{') && !noStream.text.includes('data:'));

// 3) 流式：上游说 stream:true，SSE 逐块原样透传
const streaming = await post({
  model: 'GLM-5.3-Flash', max_tokens: 8, stream: true,
  messages: [{ role: 'user', content: 'hi' }],
});
chk('上游收到的 stream 字段是 true', echo?.parsed?.stream === true);
chk('SSE Content-Type 透传', (streaming.type || '').includes('text/event-stream'), streaming.type);
chk('SSE 分片逐块透传且顺序不变',
  streaming.text === 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n',
  JSON.stringify(streaming.text.slice(0, 60)));

// 4) 请求体没被塞进任何占位工具（那是 opencode2pi#1 的做法，本插件不该有）
await post({ model: 'GLM-5.3-Flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
chk('没有往请求体里塞占位工具', echo?.parsed?.tools === undefined, JSON.stringify(echo?.parsed?.tools));
chk('没有往请求体里塞 tool_choice', echo?.parsed?.tool_choice === undefined);

await stopService();
await new Promise((r) => echoServer.close(r));
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
// 用 exitCode 而不是 process.exit()：后者会和 libuv 正在关闭的句柄赛跑，
// 在 Windows 上触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`。
process.exitCode = fail ? 1 : 0;