# 超级域名侠（Super Domain Man）

本地优先的多平台域名解析记录管理与 SSL 证书工具，运行在 [PI-Desktop](https://github.com/Tioit-Wang/PI-Desktop) 插件系统中。

集中管理多家云厂商的 DNS 解析记录，查看/申请 SSL 证书，并监控证书到期情况。**所有数据仅保存在本机**，无任何云端上报。

## 功能

- **账号管理**：阿里云 / 腾讯云 / Cloudflare / AWS Route53 / 火山引擎 / 华为云 凭据统一管理
  - 凭据直接保存在本机浏览器存储中，**无主密码保护**，打开面板即可直接使用
- **域名解析**：记录增删改查、搜索分页、启用/停用、MX 优先级、批量导入导出
- **SSL 证书**：查看证书信息，内置 ACME 客户端在线申请（Let's Encrypt 等）
- **到期监控**：通过 crt.sh 证书透明日志检查监控目标到期时间，按 30/10/5 天阈值提醒
  - 面板内提醒 + 飞书 / 钉钉 / 企业微信 / Server酱 / 通用 Webhook 推送
- **白天 / 黑夜模式**：默认跟随系统，侧边栏底部「夜间/日间」按钮一键切换，偏好本地保存

## 安装

在 PI-Desktop 的 Plugins 页面：

1. **Load development plugin** → 指向本目录；
2. 或在命令面板执行「超级域名侠：打开面板」；
3. 也可以打包后安装：`dist/pi.super-domain-man-0.2.0.piplug`，或从官方插件市场（Marketplace → Refresh from repo）安装。

## 开发

```bash
cd renderer-src
pnpm install
pnpm dev        # vite 开发服务
pnpm build      # 构建产物输出到 ../renderer
pnpm typecheck  # 类型检查
```

插件以 dev 模式加载时，保存 `renderer-src` 源码并执行 `pnpm build` 后自动热重载；`renderer/` 为已构建产物，仓库内直接可用。

## 数据与隐私

- 账号凭据：明文保存在面板 localStorage，无密码保护，请勿在共用电脑上使用；
- 网络请求：仅向云厂商 API / crt.sh / 通知 Webhook 发起，无第三方统计上报。

## 许可

MIT。界面与交互参考 [domain-helper](https://github.com/imxiny/domain-helper)（MIT）。
