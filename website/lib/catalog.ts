import type { Locale } from "./i18n";

export type Permission = string;

export type PluginVersion = {
  version: string;
  publishedAt: string;
  changelog?: string;
  minPiDesktop?: string;
  shasum?: string;
  url: string;
  sizeBytes?: number;
  permissions?: Permission[];
};

export type Plugin = {
  id: string;
  name: string;
  description: string;
  i18n?: Partial<Record<Locale, LocalizedPluginContent>>;
  author: string;
  categories: string[];
  verified?: boolean;
  downloads?: number;
  homepage?: string;
  repository?: string;
  readmeMarkdown?: string | null;
  safetyNotes?: string | null;
  versions: PluginVersion[];
};

export type LocalizedPluginContent = {
  name?: string;
  description?: string;
  safetyNotes?: string | null;
  changelog?: string;
  readmeMarkdown?: string | null;
};

export type Catalog = {
  schemaVersion: number;
  providerId: string;
  name: string;
  updatedAt: string;
  homepage: string;
  plugins: Plugin[];
};

export const CATALOG_URL =
  process.env.CATALOG_URL ??
  "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json";

export const REPOSITORY_URL = "https://github.com/vastsa/pi-desktop-plugins";

export const featuredIds = [
  "pi.gitlens",
  "pi.token-insights",
  "pi.markdown",
  "pi.todo",
];

export async function getCatalog(): Promise<Catalog> {
  const response = await fetch(CATALOG_URL, { next: { revalidate: 300 } });

  if (!response.ok) {
    throw new Error(`Unable to load plugin catalog: ${response.status}`);
  }

  return response.json() as Promise<Catalog>;
}

export async function getPlugin(id: string): Promise<Plugin | undefined> {
  const catalog = await getCatalog();
  return catalog.plugins.find((plugin) => plugin.id === id);
}

export function localizedPlugin(plugin: Plugin, locale: Locale) {
  const content = plugin.i18n?.[locale] ?? plugin.i18n?.en ?? {};
  return {
    ...plugin,
    name: content.name ?? plugin.name,
    description: content.description ?? plugin.description,
    safetyNotes: content.safetyNotes ?? plugin.safetyNotes,
    readmeMarkdown: content.readmeMarkdown ?? plugin.readmeMarkdown,
  };
}

export function currentVersion(plugin: Plugin): PluginVersion {
  return plugin.versions[0];
}

export function packageUrl(plugin: Plugin): string {
  const url = currentVersion(plugin).url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return new URL(url, CATALOG_URL).toString();
}

export function formatBytes(bytes?: number): string {
  if (!bytes) return "Package size unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function permissionRisk(permissions: Permission[] = []) {
  const hasHighRisk = permissions.some((permission) =>
    ["fs.write.workspace", "net.fetch", "shell.openExternal"].includes(permission),
  );
  const hasAgentAccess = permissions.some((permission) =>
    ["agent.tool.register", "agent.prompt.inject"].includes(permission),
  );

  if (hasHighRisk) return { tone: "high" as const };
  if (hasAgentAccess) return { tone: "medium" as const };
  return { tone: "low" as const };
}

export function pluginSearchText(plugin: Plugin): string {
  return [
    plugin.id,
    plugin.name,
    plugin.description,
    plugin.author,
    ...plugin.categories,
  ]
    .join(" ")
    .toLowerCase();
}

export function sortPlugins(plugins: Plugin[]): Plugin[] {
  return [...plugins].sort((a, b) => {
    const aFeatured = featuredIds.indexOf(a.id);
    const bFeatured = featuredIds.indexOf(b.id);
    if (aFeatured !== -1 || bFeatured !== -1) {
      if (aFeatured === -1) return 1;
      if (bFeatured === -1) return -1;
      return aFeatured - bFeatured;
    }
    return a.name.localeCompare(b.name);
  });
}
