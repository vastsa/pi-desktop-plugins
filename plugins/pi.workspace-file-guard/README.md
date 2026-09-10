# 工作区文件护栏

把测试、临时、草稿、日志、缓存等垃圾文件关在当前工作区或 PI scratch 里。这是行为约束，不是磁盘锁。

便携的 PI-Desktop skill 包：启用一次后，每个会话都会注入规则并注册分类工具。路径按当前操作系统、用户主目录、工作区和环境变量解析，不写死 `C:`、用户名或某台机器的目录。

## 提供什么

- Skill：`skills/workspace-file-guard.md`（插件启用期间注入 Agent）
- 工具：`project_root` / `check_path` / `temp_env` / `tmp_layout`
- 拒绝清单：`references/denied-paths.md`
- 分类器：`guard.js`

## 文件该写到哪

| 类型 | 位置 |
| --- | --- |
| 用户要求保留的源码 | 工作区（`src/`、`tests/` 等） |
| 一次性草稿、转储、日志 | `$PI_SCRATCH_DIR` |
| 项目本地缓存 | `$project/.tmp/cache` |

禁止：桌面、下载、文档、系统临时目录；项目在其他盘时禁止写到系统盘；Program Files、`/usr`、`/Applications`。

## 权限

| 权限 | 用途 |
| --- | --- |
| `agent.prompt.inject` | 注入护栏规则，让 Agent 默认把垃圾文件关在工作区 / scratch |
| `agent.tool.register` | 注册路径分类工具，供 Agent 在写文件前查询 |

不申请 `fs.*` 宿主文件系统权限、网络、剪贴板或后台服务权限。为识别 Linux/XDG 自定义用户目录，分类器会只读本机 `~/.config/user-dirs.dirs`（若存在），不会上传或返回该文件原文。插件本身不写盘、不改 ACL、不联网；真正落盘的仍是 Agent 自己的 Write / Bash。

## 安装

1. PI-Desktop → 扩展 → 安装插件包，选择 `packages/pi.workspace-file-guard-0.2.5.piplug`。
2. 若出现权限确认，勾选 `agent.prompt.inject` 与 `agent.tool.register`（当前宿主对本地 `.piplug` 可能按清单静默全授）。
3. 新开一个 Agent 会话，skill 才会注入。

也可把本目录当作开发插件加载（保存后热重载）。开发插件扩权后请重新「加载开发插件」，不要只点「重新加载」。

## 开发验证

```bash
node tests/workspace-file-guard-guard.test.js
node tests/workspace-file-guard-main.test.js
python scripts/pack_plugin.py plugins/pi.workspace-file-guard
python scripts/rebuild_catalog.py
python scripts/security_audit.py --check-packages
```

## 能力边界

- 不是事后清理磁盘。
- 不是跨项目访问隔离。
- 不是操作系统沙箱、BitLocker、SIP 或文件夹 ACL。
- `root` 覆盖只在用户明确选择项目根时使用；工具无法验证该选择，不能把它当成安全边界。
- `explicit` 只是模型对用户意图的声明；桌面、下载、文档和系统临时目录即使标记也禁止。

## 能力 / 数据流

| 能力 | 数据 | 方向 |
| --- | --- | --- |
| `agent.prompt.inject` | 本插件 `skills/workspace-file-guard.md` 规则文本 | 注入当前会话的系统提示，不读聊天记录 |
| `agent.tool.register` | 调用参数里的路径字符串；`pi.workspace.get()` 的工作区路径；`PI_SCRATCH_DIR` / 主目录 / 常见系统目录 | 只返回分类结果与环境变量建议，不写盘 |
| 文件系统 | 本机 `~/.config/user-dirs.dirs`（若存在） | 仅用于识别 XDG 用户目录，不上传、不返回原文 |
| 网络 / 剪贴板 / 后台服务 | 无 | 不申请、不使用 |

失败路径：没有打开工作区且未传 `root` 时工具返回 `ok: false`，不会回退到插件安装目录或 cwd。桌面、下载、文档、系统临时目录即使 `explicit=true` 也拒绝。
