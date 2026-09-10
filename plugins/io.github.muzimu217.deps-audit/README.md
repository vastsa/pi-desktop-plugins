# Deps Audit — io.github.muzimu217.deps-audit

依赖漏洞扫描：把工作区交给 [osv-scanner](https://github.com/google/osv-scanner)，
把结果以 OSV 数据库的分类与严重度展示在工作面板里；选中一条，Agent 给出**最小升级或修复方案**
（不会自动改任何文件，必须你确认）。

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
| `agent.complete` | 让 Agent 在对话里给修复建议 |
| `agent.tool.register` | 注册 `deps_audit_run` 工具（high-risk，需用户授权） |
| `models.list` | 供 Agent 端选择模型时枚举 |

**不**需要的：
- `fs.read` / `fs.write` —— 插件**不**直接读 manifest。osv-scanner 自己读文件。
  读取范围 = osv-scanner 内置策略，由它决定。
- `net.fetch` —— 插件本身不联网。OSV 数据库由 osv-scanner 自己拉取。

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
   `osv-scanner scan source -L package.json --format json` 看耗时。
3. **JSON 解析失败** → 极少见，说明 osv-scanner 输出了不兼容的版本。请把 stderr 贴到
   issue 里。

## 设计选择

- **为什么不让插件直接 `fs.read` 读 manifest**？因为 osv-scanner 才是领域专家；它内置的
  解析器支持锁文件、传递依赖等插件不必再实现的逻辑。让它读，插件只做"展示 + 拉 Agent"。
- **为什么是"复制给 Agent"而不是一键 fix**？升级依赖是高风险操作（破坏性变更、lock 重生、
  影响下游）。让 Agent 先解释、再给方案、最后由你点头，是最不容易出事的人机协作。
- **为什么 `agent.tool.register` 是 high-risk**？注册到 Agent 的工具会被自动调用，而工具
  结果会进入 Agent 的下一步推理。我们宁可让用户在安装时多看一眼。

## 开发

```bash
# 在 PI-Desktop 仓库内校验
cd ~/dev/pi-desktop
env -u NODE_OPTIONS -u PYTHONPATH ./node_modules/.bin/pi-plugin check \
  ~/dev/pi-desktop-plugin-lab/deps-audit

# 跑测试（17 项）
node --test ~/dev/pi-desktop-plugin-lab/deps-audit/test/parser.test.mjs
node --test ~/dev/pi-desktop-plugin-lab/deps-audit/test/scanner.test.mjs
```

## License

MIT
