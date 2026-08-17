import Link from "next/link";
import { ArrowUpRight, Check, ShieldAlert } from "lucide-react";
import type { Plugin } from "../lib/catalog";
import { categoryLabels, currentVersion, formatBytes, permissionRisk } from "../lib/catalog";
import { PluginIcon } from "./icons";

export function PermissionBadge({ plugin }: { plugin: Plugin }) {
  const version = currentVersion(plugin);
  const permissions = version.permissions ?? [];
  const risk = permissionRisk(permissions);

  return (
    <span className={`permission-badge ${risk.tone}`} title={permissions.length ? permissions.join(", ") : "No permissions declared"}>
      {risk.tone === "high" ? <ShieldAlert size={13} /> : <Check size={13} />}
      {permissions.length} permissions
    </span>
  );
}

export function PluginCard({ plugin, featured = false }: { plugin: Plugin; featured?: boolean }) {
  const version = currentVersion(plugin);
  const primaryCategory = plugin.categories.find((category) => category !== "official") ?? plugin.categories[0];

  return (
    <article className={`plugin-card ${featured ? "featured-card" : ""}`}>
      <div className="plugin-card-topline">
        <div className="plugin-icon"><PluginIcon id={plugin.id} category={primaryCategory} /></div>
        <div className="plugin-card-meta">
          {plugin.verified && <span className="verified-label"><Check size={13} /> Official</span>}
          <span className="version-label">v{version.version}</span>
        </div>
      </div>
      <div className="plugin-card-content">
        <Link href={`/plugins/${plugin.id}`} className="card-title-link">
          <h3>{plugin.name}</h3>
        </Link>
        <p>{plugin.description}</p>
      </div>
      <div className="tag-row">
        {plugin.categories.slice(0, 2).map((category) => <span className="tag" key={category}>{categoryLabels[category] ?? category}</span>)}
      </div>
      <div className="plugin-card-footer">
        <PermissionBadge plugin={plugin} />
        <span className="card-size">{formatBytes(version.sizeBytes)}</span>
        <Link href={`/plugins/${plugin.id}`} className="card-arrow" aria-label={`View ${plugin.name}`}>
          <ArrowUpRight size={17} />
        </Link>
      </div>
    </article>
  );
}
