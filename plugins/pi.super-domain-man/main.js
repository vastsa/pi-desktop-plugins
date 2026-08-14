"use strict";

/**
 * 超级域名侠 — PI-Desktop 插件主进程
 *
 * 插件 id: pi.super-domain-man
 * 命令 id: super-domain-man.open
 * agent 工具: domain_manage
 *
 * 数据模型：
 *   面板数据存储于渲染进程 localStorage（sdm.accounts / sdm.monitor / sdm.settings）。
 *   面板通过 onPanelInvoke 的 "domain.sync" 通道将监控目标同步到本进程的
 *   插件数据目录 settings.json，AI 工具直接读取缓存数据。
 *   账号凭据经 PBKDF2 + AES-GCM 加密，仅保存在面板本地，AI 工具不可获取密钥。
 *
 * 权限说明：
 * - ui.panel：面板入口（manifest.ui.panel）
 * - net.fetch：crt.sh 证书透明日志查询
 * - notify：到期提醒通知
 * - agent.tool.register：注册 agent 工具 domain_manage
 */

const DOMAIN_ACTIONS = [
  "list_accounts",
  "list_domains",
  "list_records",
  "list_monitors",
  "check_certificates",
  "add_record",
  "update_record",
  "delete_record",
  "search_records",
];

// ---- 内存缓存（从面板同步） ----
let cachedAccounts = [];
let cachedMonitors = [];

async function loadSettings() {
  try {
    return (await pi.plugin.getSettings()) || {};
  } catch {
    return {};
  }
}

async function saveSettings(s) {
  await pi.plugin.setSettings(s);
}

async function initCache() {
  const s = await loadSettings();
  cachedAccounts = Array.isArray(s.cachedAccounts) ? s.cachedAccounts : [];
  cachedMonitors = Array.isArray(s.cachedMonitors) ? s.cachedMonitors : [];
}

async function persistCache() {
  const s = await loadSettings();
  s.cachedAccounts = cachedAccounts;
  s.cachedMonitors = cachedMonitors;
  await saveSettings(s);
}

// ---- crt.sh 证书查询 ----

function daysUntil(ts) {
  if (!ts) return null;
  return Math.ceil((ts - Date.now()) / 86400000);
}

async function queryCrtSh(host) {
  const url = "https://crt.sh/?q=" + encodeURIComponent(host) + "&output=json";
  const resp = await pi.net.fetch(url, { timeout: 12000 });
  if (resp.status !== 200) return null;
  let data;
  try {
    data = JSON.parse(resp.bodyText);
  } catch {
    return null;
  }
  if (!Array.isArray(data) || data.length === 0) return null;

  const domain = host.toLowerCase().replace(/\.$/, "");
  const matched = data.filter(function (cert) {
    const names = String(cert.name_value || "")
      .split("\n")
      .map(function (n) {
        return n.trim().toLowerCase();
      });
    return names.some(function (n) {
      return (
        n === domain ||
        (n.startsWith("*.") && domain.endsWith(n.slice(1)))
      );
    });
  });

  const pool = matched.length > 0 ? matched : data;
  const latest = pool
    .filter(function (c) {
      return c.not_after;
    })
    .sort(function (a, b) {
      return Date.parse(b.not_before || 0) - Date.parse(a.not_before || 0);
    })[0];

  if (!latest) return null;
  const notAfter = Date.parse(latest.not_after);
  return {
    notBefore: Date.parse(latest.not_before),
    notAfter: notAfter,
    daysLeft: daysUntil(notAfter),
    issuer: latest.issuer_name || "",
    isWildcard: String(latest.name_value || "").includes("*."),
  };
}

function certStatus(daysLeft) {
  if (daysLeft === null || daysLeft === undefined) return "unknown";
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= 5) return "critical";
  if (daysLeft <= 10) return "warning";
  if (daysLeft <= 30) return "notice";
  return "ok";
}

// ---- 核心操作 ----

async function runDomainAction(args) {
  const action = String(args.action || "");
  if (!DOMAIN_ACTIONS.includes(action)) {
    return { ok: false, error: "未知 action: " + action };
  }

  switch (action) {
    // ─── 账号管理 ───
    case "list_accounts": {
      if (cachedAccounts.length === 0) {
        return {
          ok: true,
          accounts: [],
          hint: "暂无已同步的账号数据。请在面板中配置云厂商账号并解锁主密码，面板会自动同步账号元信息到 AI 工具。",
        };
      }
      return {
        ok: true,
        accounts: cachedAccounts.map(function (a) {
          return {
            id: a.id,
            cloud: a.cloud,
            tag: a.tag || "未命名",
            domainCount: Array.isArray(a.domains) ? a.domains.length : 0,
          };
        }),
      };
    }

    // ─── 域名列表 ───
    case "list_domains": {
      const aid = String(args.account_id || "");
      if (!aid) return { ok: false, error: "缺少 account_id" };
      const acc = cachedAccounts.find(function (a) {
        return a.id === aid;
      });
      if (!acc) {
        return {
          ok: false,
          error: "未找到该账号。请先使用 list_accounts 获取可用账号列表。",
        };
      }
      return {
        ok: true,
        account: { id: acc.id, cloud: acc.cloud, tag: acc.tag },
        domains: (acc.domains || []).map(function (d) {
          return {
            domain: d.domain,
            cloud: d.cloud,
            expire_time: d.expire_time || null,
          };
        }),
      };
    }

    // ─── DNS 记录操作（需面板参与） ───
    case "list_records":
    case "search_records":
    case "add_record":
    case "update_record":
    case "delete_record": {
      return {
        ok: false,
        error:
          "DNS 记录的查询与修改需要实时调用云厂商 API（凭据加密存储于面板本地），请在「超级域名侠」面板中操作。可使用 open_panel 命令打开面板。",
        action: "open_panel",
      };
    }

    // ─── SSL 监控目标 ───
    case "list_monitors": {
      if (cachedMonitors.length === 0) {
        return {
          ok: true,
          monitors: [],
          hint: "暂无监控目标。请在面板「到期监控」页面添加域名。",
        };
      }
      return {
        ok: true,
        monitors: cachedMonitors.map(function (m) {
          const dl = daysUntil(m.expire_time);
          return {
            id: m.id,
            uri: m.uri,
            host: m.host,
            domain: m.domain,
            remark: m.remark || "",
            expire_time: m.expire_time || null,
            days_left: dl,
            status: certStatus(dl),
            last_error: m.last_error || null,
          };
        }),
      };
    }

    // ─── 证书状态检查（通过 crt.sh） ───
    case "check_certificates": {
      const targets = cachedMonitors.filter(function (m) {
        return m.host;
      });
      if (targets.length === 0) {
        return {
          ok: true,
          results: [],
          message: "暂无监控目标，请先在面板「到期监控」中添加域名。",
        };
      }
      const limit = Math.min(targets.length, 10);
      const results = [];
      for (let i = 0; i < limit; i++) {
        const m = targets[i];
        try {
          const cert = await queryCrtSh(m.host);
          const dl = cert ? cert.daysLeft : null;
          results.push({
            uri: m.uri,
            host: m.host,
            certificate: cert,
            days_left: dl,
            status: certStatus(dl),
          });
        } catch (e) {
          results.push({
            uri: m.uri,
            host: m.host,
            certificate: null,
            status: "error",
            error: e.message,
          });
        }
      }
      return {
        ok: true,
        results: results,
        checked: results.length,
        total: targets.length,
      };
    }

    default:
      return { ok: false, error: "未支持的操作" };
  }
}

// ---- 生命周期 ----

async function onLoad() {
  await initCache();

  await pi.commands.register({
    id: "super-domain-man.open",
    title: "超级域名侠：打开面板",
    keywords: [
      "域名",
      "DNS",
      "SSL",
      "解析",
      "证书",
      "超级域名侠",
      "域名侠",
      "证书监控",
      "ACME",
    ],
    run: async () => {
      await pi.ui.openPanel();
    },
  });

  await pi.agent.registerTool({
    name: "domain_manage",
    description:
      "管理域名解析记录和 SSL 证书监控（pi.super-domain-man 插件）。" +
      "支持：list_accounts 查看云厂商账号列表；" +
      "list_domains 列出指定账号下的域名（需要 account_id）；" +
      "list_records 查询 DNS 记录（需面板操作）；" +
      "list_monitors 查看 SSL 证书监控目标；" +
      "check_certificates 通过 crt.sh 检查监控域名的证书到期状态；" +
      "search_records 搜索记录（需面板操作）；" +
      "add_record / update_record / delete_record 管理 DNS 记录（需面板操作）。" +
      "账号凭据加密存储于面板本地，AI 工具仅可查看账号元信息，无法获取密钥。",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: DOMAIN_ACTIONS,
          description: "要执行的操作",
        },
        account_id: {
          type: "string",
          description: "账号 ID（list_domains 时使用）",
        },
        domain: {
          type: "string",
          description:
            "域名（list_records / add_record / update_record / delete_record 时使用）",
        },
        record_id: {
          type: "string",
          description: "记录 ID（update_record / delete_record 时使用）",
        },
        name: {
          type: "string",
          description:
            "主机记录，如 www、@、mail（add_record / update_record 时使用）",
        },
        type: {
          type: "string",
          description:
            "记录类型：A、AAAA、CNAME、MX、TXT、NS 等（add_record / update_record 时使用）",
        },
        value: {
          type: "string",
          description: "记录值（add_record / update_record 时使用）",
        },
        ttl: {
          type: "integer",
          description: "TTL 秒数（add_record / update_record 时使用，默认 600）",
        },
        keyword: {
          type: "string",
          description: "搜索关键词（search_records 时使用）",
        },
      },
      required: ["action"],
    },
    execute: async (args) => runDomainAction(args || {}),
  });
}

/**
 * 面板 → 插件进程通道。
 * "domain.sync"：面板把监控目标和账号元信息同步到缓存（settings.json）。
 */
async function onPanelInvoke(channel, payload) {
  if (channel === "domain.sync" && payload) {
    if (Array.isArray(payload.accounts)) {
      cachedAccounts = payload.accounts;
    }
    if (Array.isArray(payload.monitors)) {
      cachedMonitors = payload.monitors;
    }
    await persistCache();
    return { ok: true };
  }
  throw new Error("unsupported panel channel: " + channel);
}

async function onUnload() {
  await pi.commands.unregister("super-domain-man.open");
  await pi.agent.unregisterTool("domain_manage");
}

module.exports = { onLoad, onUnload, onPanelInvoke };
