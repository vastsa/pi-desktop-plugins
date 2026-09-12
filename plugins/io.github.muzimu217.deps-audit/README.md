# Deps Audit — io.github.muzimu217.deps-audit

依赖漏洞扫描：把工作区交给 [osv-scanner](https://github.com/google/osv-scanner)，
把结果以 OSV 数据库的分类与严重度展示在工作面板里；选中一条，Agent 给出**最小升级或修复方案**
（不会自动改任何文件，必须你确认）。

## 安全模型（威胁模型）

Deps Audit 触及两类高权能力：**原生进程执行**（osv-scanner）与**网络**（osv-scanner
自行访问 OSV 数据库）。按仓库 SECURITY.md 这是 High 风险档，插件的约束设计：

1. **工作区读取只走宿主网关**：清单文件通过 `pi.fs.readText` 读取，作用域在
   manifest 的 `fs.read` 声明里逐文件列出（package.json、各语言锁文件等），
   工作区其余内容对插件不可见。
2. **原生二进制永不直接接触工作区**：读取到的清单内容以净化副本形式写入一次性
   临时目录，osv-scanner 只被允许扫描该目录；扫描结束后副本即被删除。
3. **网络边界**：插件进程自身零网络请求；对 OSV 数据库的访问由 osv-scanner
   二进制自行完成（这是它作为扫描器的核心功能）。
4. **只读承诺**：工作区永不被写入；选中漏洞后「请 Agent 修复」永远需要用户
   显式发起，插件只生成请求文本。
5. **失败可见**：二进制缺失/损坏、扫描超时、非零退出、输出不可解析都有明确的
   结构化错误与测试覆盖，不会静默吞掉。

## 为什么需要这个插件

PI-Desktop 的 `pi.advisor` 已经在做"second opinion reviewer"，但**没有插件做"把工作区
交给一个真实的依赖扫描器，再用 Agent 解读结果"这一段**。OSV.dev 是 Google 维护的开放漏洞
数据库，覆盖 npm / PyPI / crates.io / Go / Maven / Composer / RubyGems，且 osv-scanner 是
Apache-2.0 的纯本地 CLI——非常适合作为"安全侧"输入。

## 安装

Deps Audit **不强依赖** osv-scanner 二进制存在；如果没装，它会给出明确指引（详见
故障排查）。最稳的安装方式：

```bash
# 方式 1: Homebrew (macOS / Linux)
brew install osv-scanner

# 方式 2: Go
go install github.com/google/osv-scanner/v2/cmd/osv-scanner@latest

# 方式 3: GitHub release（注意 macOS 需 ad-hoc 签名或下载未压缩的 brew bottle）
# https://github.com/google/osv-scanner/releases
```

## 使用

打开 PI-Desktop，在工作面板里点 **Deps Audit**（盾牌图标），或：

- **命令面板**（`Cmd+K` / `Ctrl+K`）：
  - `Deps Audit: Open Work-Panel View` — 打开面板
  - `Deps Audit: Scan Workspace Now` — 立即扫描
- **Agent 工具**：`deps_audit_run` — Agent 在需要时可以主动调起扫描

## 工作流程

1. 打开视图，点击「扫描」
2. 插件 spawn 你本地的 `osv-scanner` 扫描工作区根下的 manifest（`package.json`、
   `requirements.txt`、`Cargo.toml` 等）
3. osv-scanner 拉取 OSV 数据库（**它**做的网络请求，**插件本身不联网**），返回结构化 JSON
4. 插件解析后按严重度（Critical → High → Medium → Low）展示在工作面板
5. 选中一条 → 点击「复制给 Agent 询问修复建议」→ 文本里包含漏洞摘要、固定版本、advisory 链接
6. 粘到 PI-Desktop 对话框 → Agent 先解释风险，给出最小升级方案，**等你确认**才改文件

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `ui.panel` / `ui.view` | 工作面板视图 |
| `fs.read` | 经宿主网关读取工作区根目录的依赖清单（逐文件列在 manifest 的 `fs.read` 作用域里），用于生成净化副本 |
| `clipboard.write` | 「复制给 Agent」经宿主剪贴板桥写入 |
| `agent.tool.register` | 注册 `deps_audit_run` 工具（risk: high —— 原生执行 + 联网） |

**不**声明、也**不**使用的：
- `agent.complete` / `models.list` —— 修复建议由你在对话里向 Agent 发起，插件不调用模型。
- `fs.write` / `fs.delete` —— 工作区永不被写入或删除。
- `net.fetch` —— 插件进程自身零网络请求；OSV 数据库由 osv-scanner 二进制自行拉取
  （该联网行为属于 SECURITY.md High 档的原生执行能力，已在安全模型小节声明）。

## 支持的 manifest

`package.json` / `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` /
`requirements.txt` / `pyproject.toml` / `Pipfile` /
`Cargo.toml` / `Cargo.lock` / `go.mod` / `go.sum` /
`pom.xml` / `composer.json` / `composer.lock` / `Gemfile` / `Gemfile.lock`

Agent 工具 `deps_audit_run` 可通过 `manifests` 参数收窄范围。

## 设置

- `scannerPath` — `osv-scanner` 二进制路径或 PATH 中的名字（默认 `osv-scanner`）
- `severityMin` — 严重度过滤（`low` / `medium` / `high` / `critical`，默认 `low`）

## 故障排查

**症状**：扫描后状态条显示"出错"且面板顶部红色 banner

最常见原因：

1. **未安装 osv-scanner** → 按上面"安装"小节装一个，或在设置里改 `scannerPath` 指向
   你自己装的二进制。
2. **超时**（>120 秒）→ 仓库很大、依赖很多、或 OSV 数据库下载慢。可手动先跑
   `osv-scanner scan source --format json .` 看耗时。
3. **JSON 解析失败** → 极少见，说明 osv-scanner 输出了不兼容的版本。请把 stderr 贴到
   issue 里。

## 设计选择

- **为什么清单要先复制到临时目录再扫**？osv-scanner 是原生二进制，按 SECURITY.md 属于
  High 风险能力。让它只读取插件经宿主网关读到的清单副本（一次性临时目录、扫描后即删），
  被拉起的二进制就永远不会直接触碰工作区——边界先在插件侧守住，宿主网关是第二道锁。
- **为什么过滤列表只按证据逐个加**？真实用户会粘贴以 `#` 开头的 markdown（比如
  `# Role: 资深工程师`），一刀切会误伤真实内容。合成前缀只从真实归档里逐个取证，
  新注入出现时按同样方式扩展。
- **为什么是"复制给 Agent"而不是一键 fix**？升级依赖是高风险操作（破坏性变更、lock 重生、
  影响下游）。让 Agent 先解释、再给方案、最后由你点头，是最不容易出事的人机协作。
- **为什么 `deps_audit_run` 是 high-risk**？它会拉起本机 osv-scanner 二进制（原生执行），
  且 osv-scanner 会联网访问 OSV 数据库。宁可让用户在授权时多看一眼。

## 开发

```bash
# 在 PI-Desktop 仓库内校验
cd ~/dev/pi-desktop
env -u NODE_OPTIONS -u PYTHONPATH ./node_modules/.bin/pi-plugin check \
  ~/dev/pi-desktop-plugin-lab/deps-audit

# 跑测试
node --test test/*.test.mjs
```

## License

MIT
