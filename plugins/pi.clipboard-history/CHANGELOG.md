# Changelog

## 0.1.0 (2026-08-21)

- 首个版本：后台采集剪贴板文本，按天归档保留 30 天
- 面板窗口：一键复制恢复、单条删除、单日清空、一键清空全部（两步确认）
- 暂停采集开关；轮询间隔可调（1–10s，默认 2s）
- 重复复制同一内容仅刷新时间戳置顶，不产生重复条目
- 单条 100 KB 截断（标记 truncated）；单日 5 MB 上限丢弃最旧
- 权限被拒时停止采集并每 60s 自动重试；视图隐藏时暂停轮询
- 数据仅存本地明文 JSONL，无任何网络传输

Initial release: background clipboard capture, 30-day daily archives, panel
with one-click restore / delete / clear, pause toggle, configurable poll
interval (1–10s, default 2s), 100 KB per-entry truncation, 5 MB per-day cap,
permission-denied auto-retry, local-only plaintext storage.