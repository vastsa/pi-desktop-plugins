# PI-Desktop Plugins

Official **plugin source** and **GitHub raw fallback mirror** for [PI-Desktop](https://github.com/vastsa/PI-Desktop).

官方市场已经迁到 **[plugins.aiuo.net](https://plugins.aiuo.net)**（`pi-backend`）。本仓库不再是发布入口：

| 角色 | 地址 |
| --- | --- |
| 官方 Catalog（客户端默认） | `https://plugins.aiuo.net/catalog.json` |
| GitHub 回退镜像 | `https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json` |
| 源码与测试 | 本仓库 `plugins/`、`tests/` |

CI 每小时从官方源拉取 `catalog.json` 和 `.piplug`。**拉取失败不会覆盖**上次成功的文件，所以 GitHub raw 始终是一份可安装的完整镜像（相对路径 `packages/*.piplug`，不带 `artifactBaseUrl`，客户端不会在回退时打回已宕的源站）。

发布、审核、yank、权限升级一律走插件中心，不要再向本仓库提「把插件加进 catalog」的 PR。

## 安装插件

1. 打开 PI-Desktop → **插件** → **市场**
2. 官方源指向 `https://plugins.aiuo.net/catalog.json`（开发可用 `PI_DESKTOP_PLUGIN_MARKET_URL`）
3. 无法访问官方源时，客户端可切到本仓库 GitHub raw 镜像

## 发布插件（外部开发者）

1. 在 `https://plugins.aiuo.net` 用 GitHub 登录，申请 publisher slug。
2. 生成本地 CLI token（`pipt_…`）。
3. 用 `plugin-devkit`：`pi-plugin pack` → `pi-plugin publish --registry https://plugins.aiuo.net`。
4. 首个版本进入审核；通过后进入官方 catalog，并在一小时内同步到本镜像。

## 官方插件源码

`plugins/<id>/` 仍是 PI-Desktop 团队维护的源码。改官方插件：

```bash
# 1) 改代码、bump manifest.version
# 2) 本地验证
node --test tests/<name>.test.mjs
# 在 PI-Desktop 里「加载开发插件」指向 plugins/<id>

# 3) 打包（可选，本地安装用）
python3 scripts/pack_plugin.py plugins/<id>

# 4) 发布到插件中心（不要再跑 rebuild_catalog.py）
pi-plugin publish --registry https://plugins.aiuo.net
```

`python3 scripts/rebuild_catalog.py` 只用于本地/离线夹具，**不会**更新线上市场。

## 镜像同步（维护者）

```bash
python3 scripts/sync_catalog.py --dry-run
python3 scripts/sync_catalog.py --source https://plugins.aiuo.net/catalog.json
python3 -m unittest tests/test_sync_catalog.py
```

GitHub Actions：`.github/workflows/sync-catalog.yml`（每小时 + 手动）。

## 仓库内容

| 路径 | 说明 |
| --- | --- |
| `catalog.json` | 从官方源镜像的市场目录（失败不覆盖） |
| `packages/*.piplug` | 镜像下来的安装包 |
| `plugins/<id>/` | 官方插件源码 |
| `scripts/sync_catalog.py` | 镜像同步 |
| `scripts/pack_plugin.py` | 本地打包 |
| `website/` | 市场介绍站（优先读官方 catalog，失败回退 GitHub raw） |

## License

MIT
