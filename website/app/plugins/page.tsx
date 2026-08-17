import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { PluginCard } from "../../components/plugin-card";
import { SiteFooter, SiteHeader } from "../../components/site-header";
import { categoryLabels, formatDate, getCatalog, pluginSearchText, sortPlugins } from "../../lib/catalog";

export const metadata: Metadata = { title: "Browse plugins" };
export const revalidate = 300;

type SearchParams = Promise<{ q?: string; category?: string }>;

export default async function PluginsPage({ searchParams }: { searchParams: SearchParams }) {
  const catalog = await getCatalog();
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const category = params.category ?? "all";
  const plugins = sortPlugins(catalog.plugins.filter((plugin) => {
    const matchesQuery = !query || pluginSearchText(plugin).includes(query.toLowerCase());
    const matchesCategory = category === "all" || plugin.categories.includes(category);
    return matchesQuery && matchesCategory;
  }));

  return <><SiteHeader /><main className="page-shell"><div className="container"><div className="page-heading"><div><p className="section-kicker">The marketplace</p><h1>Browse plugins.</h1><p>Find small, focused extensions for your local PI-Desktop workspace.</p></div><span className="catalog-date">Catalog updated {formatDate(catalog.updatedAt)}</span></div><form className="search-bar" action="/plugins" role="search"><Search size={18} /><label htmlFor="plugin-search" className="sr-only">Search plugins</label><input id="plugin-search" name="q" defaultValue={query} placeholder="Search by name, capability or category..." /><button className="search-submit" type="submit">Search</button></form><div className="filter-row" aria-label="Filter by category">{Object.entries(categoryLabels).map(([id, label]) => <Link className={`filter-chip ${category === id ? "active" : ""}`} href={id === "all" ? "/plugins" : `/plugins?category=${id}${query ? `&q=${encodeURIComponent(query)}` : ""}`} key={id}>{label}</Link>)}</div><div className="catalog-result"><span>{plugins.length} {plugins.length === 1 ? "plugin" : "plugins"}{query ? ` matching “${query}”` : ""}</span><span>Versioned .piplug packages</span></div>{plugins.length ? <div className="catalog-grid">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} />)}</div> : <div className="empty-state"><strong>No plugins found.</strong>Try another search or clear the category filter.</div>}</div></main><SiteFooter /></>;
}
