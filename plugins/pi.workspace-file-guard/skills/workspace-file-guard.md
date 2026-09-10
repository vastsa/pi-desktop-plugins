---
name: workspace-file-guard
description: 把测试文件、临时文件、草稿脚本、日志、转储、缓存和垃圾文件关在当前工作区或 PI scratch。创建文件、跑测试、生成产物、写辅助脚本、使用 TEMP/TMP/TMPDIR、下载缓存，或在 Windows / macOS / Linux 上工作时使用。不要把这些文件写到其他卷、工作区外的系统盘、桌面、下载、文档或系统临时目录。只读检查、用户明确要求的插件/skill 安装、以及用户本轮点名的外部目标不要套用本 skill。
---

# 工作区文件护栏

把 Agent 产生的垃圾文件关在当前项目或 PI scratch 里。这是行为约束，不是操作系统锁。

插件工具（宿主前缀 `plugin_pi_workspace_file_guard_`）：

- `project_root` — 解析当前工作区 / PI scratch / `.tmp` 布局。未打开工作区且未传 `root` 时失败。
- `check_path` — 判断写入路径是否允许（`allowed=true|false`）。看 `allowed`，不要看 `ok`。相对路径相对工作区解析，不是插件进程 cwd。
- `temp_env` — TMP / TEMP / 缓存相关环境变量赋值
- `tmp_layout` — 推荐的 `$project/.tmp/{tests,scripts,cache,out}`

路径在当前机器上解析。不要假设 `C:`、`D:`、`/Users/foo` 或某个用户名。`check_path` / `temp_env` 永远不要把插件安装目录当成项目根。

## 硬性规则

1. 先解析项目根，再把测试 / 临时 / 草稿 / 脚本 / 垃圾文件只写到该根目录下，或 `$PI_SCRATCH_DIR`。
2. 不要写到其他卷。项目在 `D:` / `/data` / 其他盘时，不要在系统盘创建这些文件。
3. 即使项目本身在系统盘，也只待在该项目文件夹内。不要溢到桌面、下载、文档、图片、系统临时目录或 AppData Local Temp。
4. 不要把操作系统临时目录、Codex 可视化目录、`$CODEX_HOME/tmp`、`~/.pi-desktop/logs`、`~/.cache` 当作项目文件的倾倒场。
5. 优先用相对项目根的路径。工具需要绝对路径时，从项目根或 `$PI_SCRATCH_DIR` 生成。
6. 用户要求保留的正式源码放进项目树，不要放进 `.tmp`。一次性文件放 `.tmp` 或 PI scratch，用完可删。

命令会写到项目外时，停下来改路径。不要「就这一次」把测试文件丢到系统盘。

## 项目根

用当前用户项目，不要用 PI 内部目录。

优先级：

1. 用户点名的 `root` 参数。
2. 已打开的 PI-Desktop 工作区（`pi.workspace.get()`）。
3. 两者都没有时工具失败。不要用插件进程 cwd、插件安装目录或猜出来的 git 根。

不要把下面这些当成垃圾文件的项目根：

- `~/.pi-desktop/logs/`
- `~/.pi-desktop/cache/`
- `~/.codex/visualizations/`
- `~/.codex/tmp/`
- 系统临时目录（`os.tmpdir()`、`%TEMP%`、`%TMP%`、`/tmp`、`/var/tmp`）

不确定时先调 `project_root`。

## 文件该写到哪

| 类型 | 目标 |
| --- | --- |
| 用户要求保留的源码 | 工作区内的 `src/`、`tests/`、`scripts/` 等 |
| 一次性脚本、转储、日志、截图 | `$PI_SCRATCH_DIR`（会话草稿目录） |
| 项目本地缓存 / pytest basetemp | `$project/.tmp/cache`、`$project/.tmp/tests` |

只在需要时创建 `$project/.tmp`（应被 gitignore）。布局：

- `.tmp/tests/` 一次性测试
- `.tmp/scripts/` 一次性脚本
- `.tmp/cache/` 下载和工具缓存
- `.tmp/out/` 生成的转储、日志、截图

跑会认临时/缓存环境变量的工具前，先调 `temp_env` 并在该 shell 里应用。默认方言：Windows 用 PowerShell，其他系统用 bash。写之前用 `check_path` 检查；`allowed=false` 就必须改路径。

拒绝清单细节：[references/denied-paths.md](../references/denied-paths.md)

## 例外

仅在用户明确要求，或任务否则无法完成时允许：

- 在 `~/.pi-desktop/plugins` 安装或更新 PI 插件
- 编辑用户级 PI 配置，例如 `~/.pi/agent/AGENTS.md`
- 在 `$CODEX_HOME/skills` 安装 Codex skill
- 用户本轮点名的绝对路径或其他卷。`explicit=true` 只是模型自称，工具无法核实；桌面、下载、文档和系统临时目录仍然禁止。

仍然拒绝：把测试、草稿脚本或垃圾文件倒到桌面、下载、文档或系统临时目录，就算图方便也不行。

只读访问任意位置都可以。本 skill 只限制项目产物的写入。

## 不要和这些混淆

- 事后清理磁盘
- 跨项目访问隔离
- 操作系统沙箱、BitLocker、SIP 或文件夹权限
