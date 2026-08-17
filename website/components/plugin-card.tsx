import Link from "next/link";
import { ArrowUpRight, Check, ShieldAlert } from "lucide-react";
import type { Plugin } from "../lib/catalog";
import { currentVersion, formatBytes, localizedPlugin, permissionRisk } from "../lib/catalog";
import { categoryCopy, getCopy, localeHref, type Locale } from "../lib/i18n";
import { PluginIcon } from "./icons";

export function PermissionBadge({ plugin, locale }: { plugin: Plugin; locale: Locale }) {
  const version = currentVersion(plugin);
  const permissions = version.permissions ?? [];
  const risk = permissionRisk(permissions);
  const copy = getCopy(locale);

  return (
    <span className={`permission-badge ${risk.tone}`} title={permissions.length ? permissions.join(", ") : "No permissions declared"}>
      {risk.tone === "high" ? <ShieldAlert size={13} /> : <Check size={13} />}
      {permissions.length} {copy.detail.permissions}
    </span>
  );
}

export function PluginCard({ plugin, locale, featured = false }: { plugin: Plugin; locale: Locale; featured?: boolean }) {
  const version = currentVersion(plugin);
  const localized = localizedPlugin(plugin, locale);
  const primaryCategory = plugin.categories.find((category) => category !== "official") ?? plugin.categories[0];
  const officialLabel = getCopy(locale).detail.official;

  return (
    <article className={`plugin-card ${featured ? "featured-card" : ""}`}>
      <div className="plugin-card-topline">
        <div className="plugin-icon"><PluginIcon id={plugin.id} category={primaryCategory} /></div>
        <div className="plugin-card-meta">
          {plugin.verified && <span className="verified-label"><Check size={13} /> {officialLabel}</span>}
          <span className="version-label">v{version.version}</span>
        </div>
      </div>
      <div className="plugin-card-content">
        <Link href={localeHref(`/plugins/${plugin.id}`, locale)} className="card-title-link">
          <h3>{localized.name}</h3>
        </Link>
        <p>{localized.description}</p>
      </div>
      <div className="tag-row">
        {plugin.categories.slice(0, 2).map((category) => <span className="tag" key={category}>{categoryCopy(category, locale).label}</span>)}
      </div>
      <div className="plugin-card-footer">
        <PermissionBadge plugin={plugin} locale={locale} />
        <span className="card-size">{formatBytes(version.sizeBytes)}</span>
        <Link href={localeHref(`/plugins/${plugin.id}`, locale)} className="card-arrow" aria-label={`${getCopy(locale).detail.source}: ${localized.name}`}>
          <ArrowUpRight size={17} />
        </Link>
      </div>
    </article>
  );
}
