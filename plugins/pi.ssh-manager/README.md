# SSH 在线管理 · SSH Manager

`pi.ssh-manager` 是一个本地优先的 SSH 主机管理插件：面板保存主机连接元数据，
认证交给本机 OpenSSH、已有的 `~/.ssh/config`、ssh-agent、用户指定的私钥路径，或面板中
临时输入的密码。
插件把有限时、有限输出的 SSH 能力提供给 PI-Desktop AI。

## 能做什么

- 管理多台 SSH 主机：名称、主机、端口、用户名、私钥路径和 agent socket。
- 默认严格校验 `known_hosts`；只有用户显式选择时才使用 `accept-new`。
- 在面板中测试连接、执行一次性命令、查看 stdout/stderr，并忘记逻辑会话。
- 向 AI 暴露四个工具：
  - `plugin_pi_ssh_manager_ssh_list_hosts`
  - `plugin_pi_ssh_manager_ssh_connect`
  - `plugin_pi_ssh_manager_ssh_execute`
  - `plugin_pi_ssh_manager_ssh_disconnect`
- 常见递归删除、磁盘写入、重启、网络脚本管道等破坏性命令默认拦截。

## 认证与数据边界

插件不会持久化密码、passphrase、私钥内容、命令输出或远程 transcript。需要密码
认证时，可以在面板的「密码（不保存）」输入框中录入；密码只在当前插件进程内保存
最多 30 分钟，通过一次性 `SSH_ASKPASS` helper 交给 OpenSSH，插件重启、卸载或
超时后会自动清除。AI 工具永远不会接收密码参数，但可以复用当前内存中的密码状态。
请优先在本机配置 OpenSSH：

```sshconfig
Host production
  HostName server.example.com
  User deploy
  IdentityFile ~/.ssh/id_ed25519
```

然后在面板中把 `Host` 填为 `production`，或直接填写实际主机名。需要使用
ssh-agent 时，优先让 PI-Desktop 继承正确的 `SSH_AUTH_SOCK`，也可以在主机配置中
填写 agent socket 路径。带 passphrase 的密钥应由 ssh-agent 或系统 OpenSSH 配置
负责解锁；插件不会把它们写入设置。

“连接”创建的是插件内的逻辑会话。每次命令仍启动一个有超时和输出上限的本机
`ssh` 进程，不会在插件进程里保留一个可被后台复用的远程 shell。

## AI 使用建议

AI 应先调用 `ssh_list_hosts`，再使用用户确认过的 `profile_id` 连接。连接和执行
均是高风险工具，会经过 PI-Desktop 的工具权限策略。AI 不应要求用户把密码、私钥
或 token 粘贴到对话中；新主机密钥和破坏性命令必须先向用户确认。

## 权限

- `ui.panel`：打开 SSH 管理面板。
- `agent.tool.register`：注册 AI SSH 工具。
- `agent.prompt.inject`：加载安全 SSH 使用说明。

插件只使用本机 `ssh` 可执行文件，不使用 `net.fetch`，也不把凭据写入插件设置。

## 开发验证

```bash
node --test tests/ssh-manager.test.mjs
python3 scripts/pack_plugin.py plugins/pi.ssh-manager
python3 scripts/rebuild_catalog.py
```

本地运行时请在 PI-Desktop 中选择「插件 → 加载开发插件」，再选择本目录。
