# ZCode Free Quota

Use the free quota that comes with your **ZCode / BigModel Coding Plan** as a model provider inside PI-Desktop.

Model: `GLM-5.3-Flash` (1M context, vision).

把 **ZCode / BigModel Coding Plan** 自带的免费额度，作为模型 provider 接进 PI-Desktop。

模型：`GLM-5.3-Flash`（1M 上下文，支持读图）。

---

## How it works

```
PI-Desktop model picker
  └─ "ZCode Free Quota" group (declared in manifest, provider.register)
       └─ baseUrl http://127.0.0.1:41940/v1
            └─ resident service zcode-proxy (background.service, 127.0.0.1 only)
                 └─ https://open.bigmodel.cn/api/coding/paas/v4/chat/completions
```

Both ends speak OpenAI Chat Completions, so the relay **translates nothing** and
streams SSE through chunk by chunk.

两端都是 OpenAI Chat Completions 方言，所以中继**不做任何转换**，SSE 逐块透传。

That endpoint is not an arbitrary choice: PI-Desktop's own first-class support path
for Zhipu Coding Plan is `apiStyle: "chat_completions"` against
`https://open.bigmodel.cn/api/coding/paas/v4`
(see [ADR 0155](https://github.com/vastsa/PI-Desktop/blob/main/docs/adr/0155-zhipu-endpoint-presets.md)).
Pointing a `chat_completions` provider at BigModel's *Anthropic* endpoint instead
fails immediately — the host sends OpenAI-shaped tools (`{type, function}`) and that
endpoint rejects them with `body.tools.0.name: Field required`.

这个端点不是随便选的：PI-Desktop 对智谱 Coding Plan 的一等支持路径就是
`apiStyle: "chat_completions"` 配 `https://open.bigmodel.cn/api/coding/paas/v4`
（见 [ADR 0155](https://github.com/vastsa/PI-Desktop/blob/main/docs/adr/0155-zhipu-endpoint-presets.md)）。
反过来把 `chat_completions` 的 provider 指到 BigModel 的 *Anthropic* 端点会直接失败——
宿主发的是 OpenAI 形状的工具（`{type, function}`），那个端点会以
`body.tools.0.name: Field required` 拒绝。

## Setup

1. **Get an API key** from <https://bigmodel.cn/coding-plan/personal/overview>.
   It is the same key your ZCode client uses to sign in to the Coding Plan.
2. **Install the plugin**, then grant `provider.register` and `background.service`.
3. **Enter the key** on the provider row in Settings.
4. Pick `GLM-5.3-Flash` under "ZCode Free Quota" in the chat model picker.

1. 到 <https://bigmodel.cn/coding-plan/personal/overview> 申请一把 API Key,
   和 ZCode 客户端登录 Coding Plan 用的是同一把。
2. 装好插件后，授权 `provider.register` 与 `background.service`。
3. 在设置里的服务商行填入 Key。
4. 聊天窗模型选择器里选「ZCode免费额度」下的 `GLM-5.3-Flash`。

## Your API key never reaches this plugin

The provider is declared with `authKind: "api_key"`, so PI-Desktop keeps the key in
its own secret store and attaches it to the outgoing request. The relay forwards
request headers unchanged and has no code path that reads, stores or logs a
credential. There is no `.env`, no hard-coded key, and nothing to revoke here.

provider 声明用的是 `authKind: "api_key"`，Key 由 PI-Desktop 存在自己的密钥库里、
随出站请求附上。中继原样透传请求头，代码里没有任何读取、保存或记录凭据的路径，
没有 `.env`，没有写死的 Key，这里也没有需要吊销的东西。

## What the relay does not do

- **It does not force `stream`.** A caller that sends `stream: false` gets a complete
  JSON object back; a caller that sends `stream: true` gets SSE. This is deliberate:
  `JasonYu0822/opencode2pi-desktop` had to force `stream: true` upstream to pass
  OpenCode's anonymous free-lane gate, and that hack is what made non-streaming
  consumers receive unparseable SSE fragments
  ([issue #3](https://github.com/JasonYu0822/opencode2pi-desktop/issues/3)). BigModel's
  Coding Plan has no such gate, so this relay simply forwards what it was given.
- **It does not inject placeholder tools.** The free-lane gate that
  [issue #1](https://github.com/JasonYu0822/opencode2pi-desktop/issues/1) describes
  (`bash` + `read` stubs) is an OpenCode anonymous-channel requirement, not a
  BigModel one.
- **It does not rewrite the request body at all.** What the model sees is exactly what
  PI-Desktop sent. `passthrough.test.mjs` asserts this against a local echo upstream.

- **不强制 `stream`。** 发 `stream: false` 的调用方拿回完整 JSON 对象，发 `stream: true`
  的拿回 SSE。这是刻意的：`JasonYu0822/opencode2pi-desktop` 为了过 OpenCode 匿名通道的门禁
  被迫对上游强制 `stream: true`，而那个 hack 正是让非流式消费者收到无法解析的 SSE 碎片的原因
  （[issue #3](https://github.com/JasonYu0822/opencode2pi-desktop/issues/3)）。
  BigModel Coding Plan 没有这道门，所以这个中继原样转发。
- **不注入占位工具。** [issue #1](https://github.com/JasonYu0822/opencode2pi-desktop/issues/1)
  里的 `bash` + `read` 占位桩是 OpenCode 匿名通道的要求，不是 BigModel 的。
- **完全不改写请求体**，模型看到的就是 PI-Desktop 发出的原样。
  `passthrough.test.mjs` 用本地回显上游对这一点做了断言。

## Ports

The relay prefers `41940` and falls back to `41941`, `41942` if those are taken, so a
stale process from a previous session cannot silently hijack the provider.

中继优先用 `41940`，被占用则顺延到 `41941`/`41942`，避免上个会话的残留进程悄悄占住。

## Health check

```bash
curl http://127.0.0.1:41940/healthz
```

Returns the bound port, the upstream URL, request/failure counters and the last error.
On an upstream 4xx/5xx the relay also logs one line describing the request's field
names and counts — never content, never credentials.

返回绑定端口、上游地址、请求与失败计数、最近一次错误。上游报 4xx/5xx 时还会打一行
请求里有哪些字段、各多少个——绝不打内容或凭据。

## Permissions

| Permission | Why |
|---|---|
| `provider.register` | Materialize the declared provider row in the model picker |
| `background.service` | Run the 127.0.0.1 relay the provider's `baseUrl` points at |

No network, filesystem, clipboard or shell permission is requested. The relay opens no
listening socket on anything but loopback, and its only outbound destination is
`open.bigmodel.cn`.

## Tests

```bash
node passthrough.test.mjs
```

Points the relay at a local echo upstream and asserts request/response fidelity —
12 checks covering byte-identical request bodies, unforced `stream`, non-streaming
callers receiving JSON instead of SSE, SSE chunk order, and the absence of injected
tools or `tool_choice`.

## Credits

The provider-declaration + loopback-relay shape follows
[`JasonYu0822/opencode2pi-desktop`](https://github.com/JasonYu0822/opencode2pi-desktop).
The `buildStoreZip` packaging format was reverse-engineered from PI-Desktop's own
`packages/plugin-devkit/src/pack.ts`.

## License

MIT