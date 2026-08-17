export const siteLocales = ["en", "zh-CN"] as const;
export const locales = siteLocales;
export type Locale = string;
export const defaultLocale: Locale = "en";

export type SiteCopy = {
  nav: { browse: string; build: string; github: string; language: string };
  footer: { description: string; marketplace: string; contributing: string; source: string };
  home: {
    eyebrow: string;
    titlePrefix: string;
    titleAccent: string;
    description: string;
    browse: string;
    build: string;
    note: string;
    previewTitle: string;
    previewReady: string;
    previewNames: string[];
    stats: string[];
    startKicker: string;
    startTitle: string;
    startDescription: string;
    viewAll: string;
    exploreKicker: string;
    exploreTitle: string;
    trustKicker: string;
    trustTitle: string;
    trustDescription: string;
    trustItems: Array<{ number: string; title: string; description: string }>;
    builderKicker: string;
    builderTitle: string;
    builderDescription: string;
    builderButton: string;
  };
  categories: Record<string, { label: string; description: string }>;
  marketplace: {
    kicker: string;
    title: string;
    description: string;
    updated: string;
    searchPlaceholder: string;
    search: string;
    resultOne: string;
    resultMany: string;
    matching: string;
    packageNote: string;
    emptyTitle: string;
    emptyDescription: string;
  };
  detail: {
    plugins: string;
    official: string;
    by: string;
    catalogOfficial: string;
    download: string;
    copyUrl: string;
    copied: string;
    source: string;
    about: string;
    noReadme: string;
    facts: string;
    latestVersion: string;
    requires: string;
    packageSize: string;
    published: string;
    category: string;
    permissions: string;
    noPermissions: string;
    reviewTitle: string;
    reviewDescription: string;
    safetyNotes: string;
    installTitle: string;
    installDescription: string;
    downloadPackage: string;
  };
  docs: {
    home: string;
    kicker: string;
    title: string;
    description: string;
    quickStart: string;
    qualityTitle: string;
    qualityItems: string[];
    submitTitle: string;
    submitDescription: string;
    readGuide: string;
    localTitle: string;
    localDescription: string;
    templateTitle: string;
    templateDescription: string;
    permissionTitle: string;
    permissionDescription: string;
    packageTitle: string;
    packageDescription: string;
    sourceFirst: string;
  };
};

const english: SiteCopy = {
  nav: { browse: "Browse plugins", build: "Build a plugin", github: "GitHub", language: "Language" },
  footer: { description: "A calm, local-first extension catalog for PI-Desktop.", marketplace: "Marketplace", contributing: "Contributing", source: "Source code" },
  home: {
    eyebrow: "Official extension catalog",
    titlePrefix: "Make your workspace",
    titleAccent: "more capable.",
    description: "Tools, panels, skills and workflows for PI-Desktop — built to stay close to your code and your machine.",
    browse: "Browse all plugins",
    build: "Build a plugin",
    note: "Open source packages · Explicit permissions · No account required",
    previewTitle: "Installed extensions",
    previewReady: "ready",
    previewNames: ["Git Lens", "Token Insights", "Todo List"],
    stats: ["plugins in the catalog", "ways to find your fit", "reviewable package source", "cloud accounts needed"],
    startKicker: "Start here",
    startTitle: "Useful from the first session.",
    startDescription: "A small, focused catalog for the moments when your agent needs one more capability.",
    viewAll: "View all plugins",
    exploreKicker: "Explore by intent",
    exploreTitle: "Find the right kind of help.",
    trustKicker: "Designed for trust",
    trustTitle: "Keep the useful parts visible.",
    trustDescription: "Every plugin is inspectable before it enters your workspace. You decide what it can access.",
    trustItems: [
      { number: "01 / SOURCE", title: "Open package source", description: "Read the manifest, README and implementation before installing a package from the official repository." },
      { number: "02 / PERMISSIONS", title: "Explicit capabilities", description: "Filesystem, network, shell and agent permissions are surfaced as part of the browse experience." },
      { number: "03 / DELIVERY", title: "Simple package flow", description: "Download a versioned .piplug package, install it in PI-Desktop, then review the host permission prompt." },
    ],
    builderKicker: "For builders",
    builderTitle: "Build the extension your workflow is missing.",
    builderDescription: "The repository includes small examples and practical templates to help you go from idea to installable package.",
    builderButton: "Read the contribution guide",
  },
  categories: {
    all: { label: "All plugins", description: "Everything in the catalog." },
    productivity: { label: "Productivity", description: "Small tools that keep your work moving." },
    "developer-tools": { label: "Developer tools", description: "Inspect, change and understand your codebase." },
    community: { label: "Community", description: "Plugins built by the PI-Desktop community." },
    official: { label: "Official", description: "Maintained in the official plugin catalog." },
    template: { label: "Templates", description: "Starting points for building your own plugin." },
  },
  marketplace: {
    kicker: "The marketplace", title: "Browse plugins.", description: "Find small, focused extensions for your local PI-Desktop workspace.", updated: "Catalog updated", searchPlaceholder: "Search by name, capability or category...", search: "Search", resultOne: "plugin", resultMany: "plugins", matching: "matching", packageNote: "Versioned .piplug packages", emptyTitle: "No plugins found.", emptyDescription: "Try another search or clear the category filter.",
  },
  detail: {
    plugins: "Plugins", official: "Official", by: "by", catalogOfficial: "Official catalog", download: "Download .piplug", copyUrl: "Copy package URL", copied: "Copied", source: "View source", about: "About this plugin", noReadme: "No README is available yet. Visit the source repository for implementation details.", facts: "Plugin facts", latestVersion: "Latest version", requires: "Requires", packageSize: "Package size", published: "Published", category: "Category", permissions: "Permissions", noPermissions: "No permissions declared.", reviewTitle: "Review before installing", reviewDescription: "This plugin requests capabilities that may access your workspace, network or external applications.", safetyNotes: "Safety notes", installTitle: "Install in PI-Desktop", installDescription: "Download the package, then open Plugins → Install .piplug and review the host permission prompt.", downloadPackage: "Download package",
  },
  docs: {
    home: "Home", kicker: "For builders", title: "Build a plugin.", description: "PI-Desktop plugins are small, versioned packages that add tools, panels, skills and workflows to a local workspace.", quickStart: "Quick start", qualityTitle: "What makes a good plugin?", qualityItems: ["Clear README explaining what the plugin does and what it can access.", "Semantic versioning and a short changelog for every published version.", "A minimum permission set with plain-language safety notes.", "Localized panel titles when a plugin provides a UI panel."], submitTitle: "Submit to the catalog", submitDescription: "Follow the full contribution checklist in the repository. Once merged, the raw catalog and package become available to PI-Desktop users.", readGuide: "Read CONTRIBUTING.md", localTitle: "Local verification", localDescription: "Load the development plugin in PI-Desktop, confirm its commands and panels, inspect the permission behavior, then test the packaged .piplug artifact before opening a pull request.", templateTitle: "Start from a template", templateDescription: "Copy the practical workspace summary template or the smallest Hello example.", permissionTitle: "Request only what you need", permissionDescription: "Permissions are reviewed by users and should be kept as narrow as possible.", packageTitle: "Pack and publish", packageDescription: "Build a .piplug package, rebuild the catalog, then open a pull request.", sourceFirst: "The official catalog is intentionally source-first: read the manifest and README before installing.",
  },
};

const simplifiedChinese: SiteCopy = {
  nav: { browse: "浏览插件", build: "开发插件", github: "GitHub", language: "语言" },
  footer: { description: "面向 PI-Desktop 的安静、本地优先插件目录。", marketplace: "插件市场", contributing: "参与贡献", source: "源代码" },
  home: {
    eyebrow: "官方扩展目录", titlePrefix: "让你的工作区", titleAccent: "更加强大。", description: "为 PI-Desktop 提供工具、面板、技能和工作流，让能力始终贴近你的代码和本机。", browse: "浏览全部插件", build: "开发插件", note: "开源包 · 权限透明 · 无需账号", previewTitle: "已安装扩展", previewReady: "就绪", previewNames: ["Git Lens", "Token 用量分析", "小清新待办"], stats: ["目录中的插件", "种查找方式", "可审阅的包源码", "所需云端账号"], startKicker: "从这里开始", startTitle: "第一次使用就能派上用场。", startDescription: "专注而小巧的目录，解决 Agent 只差一个能力的时刻。", viewAll: "查看全部插件", exploreKicker: "按目的探索", exploreTitle: "找到适合你的能力。", trustKicker: "为信任而设计", trustTitle: "把真正有用的信息放在明面上。", trustDescription: "每个插件进入工作区之前都可以被检查。它能访问什么，由你决定。", trustItems: [{ number: "01 / 源码", title: "开放包源码", description: "从官方仓库安装前，先阅读 manifest、README 和实际实现。" }, { number: "02 / 权限", title: "明确的能力边界", description: "文件、网络、Shell 和 Agent 权限都会在浏览过程中直接展示。" }, { number: "03 / 安装", title: "简单的包流程", description: "下载版本化的 .piplug 包，在 PI-Desktop 中安装，然后检查宿主权限提示。" }], builderKicker: "面向开发者", builderTitle: "开发你的工作流所缺少的插件。", builderDescription: "仓库提供小型示例和实用模板，帮助你从想法开始，完成可安装的插件包。", builderButton: "阅读贡献指南",
  },
  categories: { all: { label: "全部插件", description: "目录中的全部插件。" }, productivity: { label: "效率工具", description: "让工作持续推进的小工具。" }, "developer-tools": { label: "开发工具", description: "检查、修改和理解你的代码库。" }, community: { label: "社区插件", description: "由 PI-Desktop 社区构建的插件。" }, official: { label: "官方插件", description: "维护在官方插件目录中。" }, template: { label: "模板", description: "开发自己插件的起点。" } },
  marketplace: { kicker: "插件市场", title: "浏览插件。", description: "为本地 PI-Desktop 工作区寻找小而专注的扩展。", updated: "目录更新于", searchPlaceholder: "按名称、能力或分类搜索……", search: "搜索", resultOne: "个插件", resultMany: "个插件", matching: "匹配", packageNote: "版本化 .piplug 包", emptyTitle: "没有找到插件。", emptyDescription: "换个关键词，或清除分类筛选。" },
  detail: { plugins: "插件", official: "官方", by: "作者", catalogOfficial: "官方目录", download: "下载 .piplug", copyUrl: "复制包地址", copied: "已复制", source: "查看源码", about: "插件介绍", noReadme: "暂时没有 README，请前往源码仓库了解实现细节。", facts: "插件信息", latestVersion: "最新版本", requires: "运行要求", packageSize: "包大小", published: "发布时间", category: "分类", permissions: "权限", noPermissions: "未声明权限。", reviewTitle: "安装前请检查", reviewDescription: "该插件请求的能力可能访问你的工作区、网络或外部应用。", safetyNotes: "安全说明", installTitle: "在 PI-Desktop 中安装", installDescription: "下载插件包，然后打开“插件 → 安装 .piplug”，并检查宿主权限提示。", downloadPackage: "下载插件包" },
  docs: { home: "首页", kicker: "面向开发者", title: "开发插件。", description: "PI-Desktop 插件是小型、版本化的扩展包，可以为本地工作区增加工具、面板、技能和工作流。", quickStart: "快速开始", qualityTitle: "什么样的插件更好？", qualityItems: ["README 清楚说明插件做什么，以及会访问什么。", "每个发布版本使用语义化版本号，并附带简短变更记录。", "只申请必要权限，并用易懂的语言说明风险。", "提供 UI 面板时，同时填写本地化的面板标题。"], submitTitle: "提交到官方目录", submitDescription: "按照仓库中的完整贡献清单操作。合并后，目录和插件包就会对 PI-Desktop 用户开放。", readGuide: "阅读 CONTRIBUTING.md", localTitle: "本地验证", localDescription: "在 PI-Desktop 中加载开发插件，确认命令和面板，检查权限行为，然后在提交 PR 前测试打包后的 .piplug 文件。", templateTitle: "从模板开始", templateDescription: "复制实用的工作区摘要模板，或最小化的 Hello 示例。", permissionTitle: "只申请真正需要的权限", permissionDescription: "用户会检查插件权限，权限范围应尽可能小。", packageTitle: "打包并发布", packageDescription: "构建 .piplug 包、重建目录，然后提交 Pull Request。", sourceFirst: "官方目录坚持源码优先：安装前先阅读 manifest 和 README。" },
};

export const copy: Record<string, SiteCopy> = { en: english, "zh-CN": simplifiedChinese };

export function resolveLocale(value: unknown): Locale {
  if (typeof value !== "string") return defaultLocale;
  const candidate = value.trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(candidate) ? candidate : defaultLocale;
}

export function getCopy(locale: Locale): SiteCopy {
  return copy[locale] ?? copy[defaultLocale];
}

export function localeHref(path: string, locale: Locale): string {
  const [pathname, query = ""] = path.split("?");
  const search = new URLSearchParams(query);
  if (locale === defaultLocale) search.delete("lang");
  else search.set("lang", locale);
  const nextQuery = search.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

export function categoryCopy(category: string, locale: Locale) {
  return getCopy(locale).categories[category] ?? { label: category, description: "" };
}

export function formatLocalizedDate(date: string, locale: Locale): string {
  try {
    return new Intl.DateTimeFormat(locale || defaultLocale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(date));
  } catch {
    return new Intl.DateTimeFormat(defaultLocale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(date));
  }
}

export function localeLabel(locale: Locale): string {
  if (locale === "en") return "English";
  if (locale === "zh-CN") return "简体中文";
  try {
    return new Intl.DisplayNames([defaultLocale], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}
