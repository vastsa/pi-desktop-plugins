# Changelog

## 0.2.0 (2026-08-21)

- 支持剪贴板图片：宿主提供 `pi.clipboard.getHistory()` 时自动启用，同步采集文本与图片并按天归档
- 图片以二进制文件存储于 `history/images/<dateKey>/`，元数据写入 JSONL；列表仅对 ≤2 MiB 的图片返回缩略图
- 新增「保存图片」开关（`saveImages`，默认开启），关闭后跳过图片采集
- 一键恢复图片：通过 `pi.clipboard.writeImage` 写回剪贴板（宿主不支持时返回 `UNSUPPORTED`）
- 宿主未提供 `getHistory` 时自动回退到原有轮询（仅文本）
- `history.list` 新增 `saveImages` 字段；新增 `history.setSaveImages` 通道

Image support: sync text + images via host `getHistory` when available
(fallback to text-only polling otherwise), per-day binary image files,
save-images toggle, one-click image restore via `writeImage`.

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