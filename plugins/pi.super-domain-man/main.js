"use strict";

/**
 * 超级域名侠 - PI-Desktop 插件主进程
 *
 * 职责：注册「打开面板」命令。
 * 所有业务（DNS 管理、SSL 证书、到期监控）均在面板内完成，
 * 数据仅存储于面板本地（localStorage，凭据经 PBKDF2 + AES-GCM 加密）。
 */

async function onLoad() {
  await pi.commands.register({
    id: "super-domain-man.open",
    title: "超级域名侠：打开面板",
    keywords: ["域名", "DNS", "SSL", "解析", "证书", "超级域名侠", "域名侠", "证书监控", "ACME"],
    run: async () => {
      // 不传 title：由宿主按清单里的本地化标题（en / zh-CN）解析面板标题
      await pi.ui.openPanel();
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("super-domain-man.open");
}

module.exports = { onLoad, onUnload };
