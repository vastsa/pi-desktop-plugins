# 拒绝路径

判断一次写入是否属于项目本地时用这份清单。所有位置都在当前机器上解析，不要写死盘符或用户名。

## 项目垃圾文件一律禁止

除非当前项目根本身就在该路径里：

- 与项目根不同的卷，尤其是项目不在系统盘时的操作系统盘
- 系统临时目录：`os.tmpdir()`、`%TEMP%`、`%TMP%`、`%TMPDIR%`、`/tmp`、`/var/tmp`、`/private/tmp`
- 用户媒体目录：桌面、下载、文档、图片、音乐、视频、电影（`~/…` 以及 XDG user-dirs）
- Windows：`%LOCALAPPDATA%\Temp`、`%SystemRoot%`、`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramData%`、`%SystemDrive%\Temp`
- macOS：`/System`、`/Library`、`/Applications`、`~/Library/Caches`、`~/Library/Logs`
- Linux：`/usr`、`/bin`、`/sbin`、`/etc`、`/opt`、`/var/cache`、`/var/log`、`~/.cache`
- `~/.pi-desktop/logs`
- `~/.pi-desktop/cache`
- `~/.codex/visualizations/`
- `~/.codex/tmp/`

## 不要用系统临时目录，改写到这里

一次性文件用 `$PI_SCRATCH_DIR`；项目本地缓存用 `$project/.tmp` 或 `$project/.tmp/cache`：

| 工具 | 环境变量 / 参数 |
| --- | --- |
| 通用 | `TMP`、`TEMP`、`TMPDIR` |
| Python | `PYTHONPYCACHEPREFIX`、`PIP_CACHE_DIR`、`UV_CACHE_DIR` |
| pytest | `--basetemp .tmp/tests/pytest` |
| Node / npm | `npm_config_cache`、`npm_config_tmp` |
| pnpm | 只有确实需要本地 store 时才设 `PNPM_STORE_DIR` |
| Go | `GOCACHE`、`GOTMPDIR` |
| Rust | 一次性构建用 `CARGO_TARGET_DIR` |
| Hugging Face | `HF_HOME` |

不要用 `npm install -g` 或 `pip install --user` 把文件停在系统盘。用项目 venv 或 `node_modules`。

## 允许的主目录写入

仅当用户要求改 PI / Codex 自身时：

- `~/.pi-desktop/plugins/`
- `~/.pi/agent/`（`AGENTS.md` 及相关）
- `~/.codex/skills/`
- `~/.codex/config.toml`
- `~/.codex/AGENTS.md`

一次性文件始终允许：`$PI_SCRATCH_DIR`（会话草稿是 `~/.pi-desktop/scratch/` 时也算）。

不能当垃圾倾倒场：`~/.codex/tmp`、sessions、visualizations、`~/.pi-desktop/logs`。
