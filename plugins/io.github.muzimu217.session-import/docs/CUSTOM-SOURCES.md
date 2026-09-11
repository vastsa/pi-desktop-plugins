# 自定义扫描来源（Custom Sources）

除了内置的 6 个来源（ZCode、WorkBuddy、Claude Code、Codex、OpenCode、Pi），
你可以**用一份声明式 JSON 描述自己的工具**，让它出现在扫描列表里并像内置来源一样导入。

> **安全边界**：配置**只允许纯数据**。任何 `eval` / `code` / `require` / `transform` / `script`
> 之类的键（任意层级）都会被直接拒绝——插件运行时对用户主目录有读权限，
> 允许配置文件携带代码等同于任意代码执行。因此这里**不支持、也不会执行**任何自定义 JS。

## 放哪儿

在**当前工作区**创建：

```
docs/session-import-sources.json
```

`docs/**` 已经在插件声明的 `fs.read` 范围内，所以这个位置**不需要新增任何权限**。
文件格式可以是数组，也可以是 `{ "sources": [...] }`：

```json
[
  { "id": "mytool", "label": "My Tool", "driver": "jsonl-transcript", "root": "~/.mytool/sessions", "entry": { ... } }
]
```

写完在面板点「自定义来源 → 重新加载」，新来源会立刻出现在扫描卡片上（带 `自定义` 标签）。

## 三个 driver（对应三种磁盘格式）

| driver | 适用 | 内置使用者 |
| --- | --- | --- |
| `jsonl-transcript` | 一行一条记录的 JSONL 对话文件 | Claude Code、Codex、WorkBuddy、Pi |
| `sqlite-session` | SQLite：`session → message → part` 三层（或 session+message 两层） | ZCode、OpenCode |
| `json-tree` | 一个 JSON 文件即一个会话，对话嵌在其中 | 旧版 OpenCode / Claude 布局 |

### 1. jsonl-transcript

```json
{
  "id": "mytool",
  "label": "My Tool",
  "driver": "jsonl-transcript",
  "root": "~/.mytool/sessions",
  "extension": ".jsonl",
  "recursive": true,
  "session": {
    "idFrom": "filename",
    "titleFrom": "firstUser",
    "projectFrom": "parentDir"
  },
  "entry": {
    "rolePath": "role",
    "roleMap": { "human": "user" },
    "content": { "blocks": { "path": "message.content", "typeField": "type", "types": ["text"], "textField": "text" } },
    "tsPath": "timestamp",
    "skipTypePath": "type",
    "skipTypes": ["summary", "system"],
    "tool": {
      "typePath": "type",
      "toolTypes": ["tool_use"],
      "namePath": "name",
      "argsPath": "input",
      "resultPath": "output",
      "statusPath": "status"
    }
  }
}
```

`content` 支持四种写法（决定了文本怎么取）：

| 写法 | 含义 |
| --- | --- |
| `"content"` 或 `{ "path": "content" }` | 取该字段 |
| `{ "blocks": { "path": "message.content", "typeField": "type", "types": ["text"], "textField": "text" } }` | 数组里挑出指定 type 的块，拼接其 text（Claude 的 content 就是这种块数组） |
| `{ "first": [ {...}, {...} ] }` | 依次尝试，取第一个非空 |
| `{ "literal": "固定文本" }` | 常量 |

#### 其它 entry 键

| 键 | 作用 |
| --- | --- |
| `match: { "path": "type", "in": ["user","assistant"] }` | 只处理这类条目，其余整条跳过（sidecar 记录、标题事件等） |
| `skipTypePath` + `skipTypes` | 命中即跳过（Claude 的 `isSidechain: true` 分支） |
| `unwrapPath` | 条目被信封包着时（Codex 的 `{timestamp,type,payload}`）把内层对象提上来，所有 path 相对它；内层不存在时自动退回原条目，新旧两种格式一份 spec 通吃 |
| `drop: { "startsWith": ["<"], "roles": ["user"] }` | 丢弃注入文本（各家的 system-reminder / AGENTS.md 都是这个形状）。`roles` 限定只作用于某个角色 |
| `textOps` | 见下 |

#### textOps（纯字符串后处理）

有些工具把注入内容包在 XML 标签里，需要剥掉才能拿到真实提问。`textOps` 只做**字符串运算**，不是代码：

```json
"textOps": [
  { "op": "stripXmlBlocks", "tags": ["system-reminder", "cb_summary"], "roles": ["user"] },
  { "op": "extractXmlTag", "tag": "user_query", "roles": ["user"] }
]
```

| op | 作用 |
| --- | --- |
| `stripXmlBlocks` | 删掉 `<tag …>…</tag>`（成对）和末尾未闭合的 `<tag …>` |
| `extractXmlTag` | 若存在 `<tag>…</tag>`，返回其内部文本，否则原样返回 |

标签名会做字符集校验（只接受 `[A-Za-z][A-Za-z0-9._-]`）并限制数量，不会变成任意正则。

#### 工具调用（toolCall）

工具调用有三种落地形状，用 `entry.toolCall` 或 `entry.tool` 描述：

**A. 条目级两阶段**（WorkBuddy `function_call` → `function_call_result`；Codex `function_call` → `function_call_output`）：

```json
"toolCall": {
  "call":   { "typePath": "type", "types": ["function_call"], "idPath": "callId", "namePath": "name", "argsPath": "arguments", "argsJson": true },
  "result": { "typePath": "type", "types": ["function_call_result"], "idPath": "callId", "namePath": "name", "resultPath": "output", "statusPath": "status" }
}
```

**B. 块级两阶段**（Claude：assistant 消息里的 `tool_use` 块，由后面 user 消息里的 `tool_result` 块按 id 对上）：

```json
"toolCall": {
  "callBlocks":   { "path": "message.content", "typeField": "type", "type": "tool_use",    "idPath": "id",          "namePath": "name", "argsPath": "input", "roles": ["assistant"] },
  "resultBlocks": { "path": "message.content", "typeField": "type", "type": "tool_result", "idPath": "tool_use_id", "resultPath": "content", "statusPath": "is_error", "roles": ["user"] }
}
```

两种情况都**在结果出现时才生成 tool 消息**，调用阶段只记下 name/args —— 与内置适配器逐字一致，导入后的消息顺序不会错位。
带 `resultBlocks` 的条目如果同时有文本，文本会被抑制（Claude 内置适配器同样如此）。

**C. 单条目自带结果**（一个条目既是调用也是结果）：用 `entry.tool`（见上面完整示例）。

补充键：

| 键 | 作用 |
| --- | --- |
| `toolCall.emitUnpaired` | 默认 `false`：没有结果的调用会被丢弃（与内置一致）。设 `true` 会保留成 `running` 状态的 tool 消息 |
| `*.follow: { "marker": "Full output saved to:", "maxBytes": 4194304 }` | 结果被截断成"完整输出已存到 xxx"时，把落盘内容读回来。**只会在 spec 自己的数据根目录内读取**，越界一律保持原文本 |
| `*.argsJson: true` | 参数是 JSON 字符串时解析成对象 |
| `*.errorValues: ["error"]` | 显式指定哪些状态值算失败 |
| `*.resultFormat: "json"` | 结果**不解析块**：字符串原样，其余 `JSON.stringify`（Codex 的形状）。默认是 `"text"`：从块里取可读文本 |

#### session 键

| 键 | 作用 |
| --- | --- |
| `idFrom` | 会话 id 的取值规则（支持 `first`）；`"filename"` 用文件名 |
| `idFromEntry` | 先在**哪类条目**里找 id。Codex 每个 `response_item` 自己也有 `id`，不加这层就会把条目 id 当成会话 id：`{ "path": "type", "in": ["session_meta"] }` |
| `titleFrom` / `projectFrom` / `fallbackProject` | 标题与项目名来源 |

### 2. sqlite-session

```json
{
  "id": "mytool",
  "label": "My Tool",
  "driver": "sqlite-session",
  "db": "~/.mytool/data.db",
  "session": { "table": "session", "idCol": "id", "titleCol": "title", "pathCol": "directory", "createdCol": "time_created", "updatedCol": "time_updated" },
  "message": { "table": "message", "idCol": "id", "sessionIdCol": "session_id", "createdCol": "time_created", "dataCol": "data", "rolePath": "role", "tsPath": "time.created", "modelIdPath": "modelID", "providerIdPath": "providerID" },
  "part": { "table": "part", "messageIdCol": "message_id", "sessionIdCol": "session_id", "createdCol": "time_created", "dataCol": "data", "textTypes": ["text"], "toolType": "tool", "toolNamePath": "tool", "argsPath": "state.input", "resultPath": "state.output", "statusPath": "state.status" }
}
```

如果工具把正文直接存在 message 行里（没有 part 表），**省略 `part`** 并在 `message` 上加 `contentPath`。
数据库一律以 `readOnly` 打开，不会写入你的数据。

排序：驱动会检查表里有没有 `sequence` 列（ZCode 有、OpenCode 没有），有就按
`sequence, 时间, id` 排，否则按 `时间, id`。同一毫秒内写入的 part 因此不会错位。
可以用 `message.sequenceCol` / `part.sequenceCol` 改列名，设 `null` 则强制不用。

`session.exclude` 可以结构化地过滤行（值是绑定参数，不是拼 SQL；列不存在时忽略）：

```json
"session": { "exclude": [{ "col": "task_type", "equals": "subagent_child" }] }
```

### 3. json-tree

```json
{
  "id": "mytool",
  "label": "My Tool",
  "driver": "json-tree",
  "root": "~/.mytool/sessions",
  "extension": ".json",
  "session": { "idPath": "id", "titlePath": "title", "tsPath": "createdAt", "pathPath": "directory", "messagesPath": "messages" },
  "message": { "rolePath": "role", "content": { "path": "content" }, "tsPath": "createdAt" }
}
```

## 校验规则（会被拒绝的情况）

- `id` 不合法：必须匹配 `^[a-zA-Z][a-zA-Z0-9._-]{0,63}$`
- `id` 撞内置来源：`zcode` / `workbuddy` / `claude-code` / `codex` / `opencode` / `pi`（内置永远优先）
- `driver` 不是上表三个之一
- 出现 `eval` / `code` / `require` / `transform` / `script` / `__proto__` / `prototype` / `constructor` 等键（**任意层级**）
- 出现非数据值（函数等）
- 数据根目录是 `/` 或整个 home（拒绝扫描整个磁盘/家目录；请指到具体子目录）
- 配置文件 > 512 KB，或来源数 > 25

被拒绝的来源不会中断扫描：其它来源照常工作，面板的「自定义来源」区域会显示具体原因。

## 资源上限

默认每个来源最多扫 **2000 个文件**、单文件 **32 MB**、单文件最多解析 **20000 行**
（可在 spec 里用 `maxFiles` / `maxBytes` / `maxLines` 覆盖）。
加上既有的看门狗超时（单源扫描 90s），一个配置错误的来源不会拖死面板。

两者的行为不同，请注意：

- 超过 `maxBytes` 的文件**整个跳过**（不会读进内存）。
- 超过 `maxLines` 的文件**只解析前 N 行**。这是有意的设计取舍：内置适配器会把
  50 MB 的会话整个读进内存，插件不能这么做。需要覆盖时请自己承担内存代价
  （实测把 Codex 上限提到 128 MB 时，校验进程峰值约 1 GB）。
