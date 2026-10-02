'use strict';

/**
 * ZCode免费额度 —— PI-Desktop provider 插件
 *
 * 链路：
 *   聊天窗模型选择器「ZCode免费额度」组
 *     -> baseUrl http://127.0.0.1:<port> （manifest 静态声明，authKind=api_key）
 *       -> 本进程（background.service，仅绑 127.0.0.1）
 *         -> https://open.bigmodel.cn/api/anthropic/v1/messages
 *
 * 本插件不接触 API Key：宿主密钥库把密钥放进请求头，本进程原样透传。
 * 两端同为 Anthropic Messages，不需要任何协议转换，SSE 逐块透传。
 */

const http = require('http');

const SERVICE_ID = 'zcode-proxy';
// BigModel Coding Plan 的 OpenAI 兼容端点。这是 PI-Desktop 对智谱 Coding Plan 的
// 一等支持路径（ADR 0155：zhipuai-coding-plan 预置就是 chat_completions + 这个 URL），
// 两端方言一致，所以本进程只转发、不转换。
const DEFAULT_UPSTREAM = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
let upstream = DEFAULT_UPSTREAM;
const PORT_CANDIDATES = [41940, 41941, 41942];

// 逐跳头 + 会让 fetch 解压后又原样回写而损坏 body 的头，全部剥掉。
// accept-encoding 换成 identity：上游不压缩，我们就能直接把字节流写回响应。
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'accept-encoding',
]);

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-encoding',
  'content-length',
]);

const state = {
  port: 0,
  started: false,
  requests: 0,
  failures: 0,
  lastError: '',
};

let server = null;
let pi = null;
let log = () => {};

/** 只接受回环 Host，防DNS rebinding / 本机其它端口误连。 */
function isLoopbackHost(hostHeader) {
  if (!hostHeader) return true;
  const host = String(hostHeader).replace(/:\d+$/, '').replace(/^\[/, '').replace(/\]$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 宿主在 baseUrl 后拼的是 "/chat/completions"（见 provider-endpoint.ts 的 suffix 表），
 * manifest 里 baseUrl 写成 http://127.0.0.1:<port>/v1，拼出来正好是 /v1/chat/completions。
 * 转发时不看路径、只认健康检查，任何请求都送到固定的上游端点，
 * 这样宿主换拼接方式也不会打偏。
 */
function isHealthCheck(req, url) {
  return url.pathname === '/healthz' || url.pathname === '/health';
}

async function handleForward(req, res) {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);

  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (STRIP_REQUEST_HEADERS.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  headers['accept-encoding'] = 'identity';

  let response;
  try {
    response = await fetch(upstream, { method: req.method, headers, body });
  } catch (error) {
    state.failures += 1;
    state.lastError = String((error && error.message) || error);
    log(`上游请求失败: ${state.lastError}`);
    if (!res.headersSent) sendJson(res, 502, { error: { message: `上游请求失败: ${state.lastError}` } });
    else if (!res.writableEnded) res.end();
    return;
  }

  const outHeaders = {};
  response.headers.forEach((value, name) => {
    if (STRIP_RESPONSE_HEADERS.has(name)) return;
    outHeaders[name] = value;
  });

  if (response.status >= 400) {
    state.failures += 1;
    log(`上游返回 ${response.status}｜请求形状：${body ? describeShape(body) : '(无请求体)'}`);
  }

  res.writeHead(response.status, outHeaders);

  if (!response.body) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  let streamDone = false;

  // 客户端中途取消（用户停了生成）时立刻断开上游，别把额度烧在没人要的内容上。
  // 注意 res 的 close 在正常结束时也会触发，所以必须用 streamDone 挡住，
  // 且要 cancel 的是 reader 而不是 body —— 正在被读取时 body 是锁死的。
  const abortUpstream = () => {
    if (streamDone) return;
    streamDone = true;
    try { reader.cancel().catch(() => {}); } catch { /* 已结束 */ }
  };
  req.on('aborted', abortUpstream);
  res.on('close', abortUpstream);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) {
        abortUpstream();
        break;
      }
      res.write(Buffer.from(value));
    }
    streamDone = true;
  } catch (error) {
    streamDone = true;
    state.lastError = String((error && error.message) || error);
    log(`流式传输中断: ${state.lastError}`);
  } finally {
    if (!res.writableEnded) res.end();
  }
}

/**
 * 上游报错时打一行请求形状，方便对照到底是哪种方言。
 * 只看字段名和数量，绝不打印消息正文、工具定义或任何凭证。
 */
function describeShape(buffer) {
  try {
    const parsed = JSON.parse(buffer.toString('utf8'));
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const toolKeys = tools[0] && typeof tools[0] === 'object' ? Object.keys(tools[0]).sort() : [];
    return [
      `model=${parsed.model}`,
      `stream=${parsed.stream}`,
      `tools=${tools.length}`,
      `tools[0]字段=${toolKeys.join(',') || '(无)'}`,
      `system=${Array.isArray(parsed.system) ? 'block[]' : typeof parsed.system}`,
      `顶层=${Object.keys(parsed).sort().join(',')}`,
    ].join('  ');
  } catch {
    return `请求体不是 JSON（${buffer.length} 字节）`;
  }
}

function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', 'http://127.0.0.1');
  } catch {
    sendJson(res, 400, { error: { message: 'bad request path' } });
    return;
  }

  if (!isLoopbackHost(req.headers.host)) {
    log(`拒绝非回环请求: host=${req.headers.host}`);
    sendJson(res, 403, { error: { message: '仅允许回环访问' } });
    return;
  }

  if (isHealthCheck(req, url)) {
    sendJson(res, 200, {
      ok: state.started,
      port: state.port,
      upstream,
      model: 'GLM-5.3-Flash',
      requests: state.requests,
      failures: state.failures,
      lastError: state.lastError,
    });
    return;
  }

  state.requests += 1;
  handleForward(req, res).catch((error) => {
    state.failures += 1;
    state.lastError = String((error && error.message) || error);
    if (!res.headersSent) sendJson(res, 500, { error: { message: state.lastError } });
    else if (!res.writableEnded) res.end();
  });
}

/** 绑 127.0.0.1。manifest 里写死的是首选端口，被占用就顺延，宿主那边不用改。 */
function listen(candidates) {
  return new Promise((resolve, reject) => {
    const ports = [...new Set(candidates.filter((p) => Number.isInteger(p) && p > 0))];
    const tryPort = (index) => {
      if (index >= ports.length) {
        reject(new Error('所有候选端口都被占用'));
        return;
      }
      const onError = (error) => {
        if (error.code === 'EADDRINUSE') {
          server.removeListener('listening', onListening);
          tryPort(index + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(ports[index], '127.0.0.1');
    };
    tryPort(0);
  });
}

async function startService(context = {}) {
  if (typeof context.log === 'function') {
    const hostLog = context.log;
    log = (message) => {
      try { hostLog(message); } catch { /* 宿主日志通道可能已关 */ }
      try { console.log(`[zcode2pi] ${message}`); } catch { /* console 可能不可用 */ }
    };
  }

  if (server) return;

  server = http.createServer(handleRequest);
  const port = await listen(PORT_CANDIDATES);
  state.port = port;
  state.started = true;
  log(`provider endpoint 已启动: http://127.0.0.1:${port} -> ${upstream}`);
}

async function stopService() {
  state.started = false;
  if (!server) return;
  await new Promise((resolve) => server.close(resolve));
  server = null;
  state.port = 0;
}

module.exports = {
  /**
   * 宿主调用 onLoad() 时不传参，插件 API 挂在全局 pi 上。
   */
  async onLoad() {
    pi = globalThis.pi;
    if (!pi) {
      throw new Error('宿主插件 API 不可用：onLoad 之前应当存在全局 pi 对象');
    }
    log = (message) => {
      try { console.log(`[zcode2pi] ${message}`); } catch { /* console 可能不可用 */ }
    };

    // 先注册端点：宿主在 onLoad 返回后立刻启动声明过的服务。
    pi.services.register({
      id: SERVICE_ID,
      start: (context) => startService(context),
      stop: () => stopService(),
    });

    log('已加载；模型「GLM-5.3-Flash」可在聊天窗模型选择器的「ZCode免费额度」分组里选择');
  },

  async onUnload() {
    await stopService();
  },

  /** 单测用的缝，不是宿主契约的一部分。 */
  _internals: {
    state,
    PORT_CANDIDATES,
    get upstream() { return upstream; },
    /** 测试时把转发目标换成本地回显服务器，验证请求体逐字节透传。 */
    setUpstream(value) { upstream = value; },
    isLoopbackHost,
    handleRequest,
    startService,
    stopService,
  },
};