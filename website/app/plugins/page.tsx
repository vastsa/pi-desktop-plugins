import type { Metadata } from "next";
import Link from "next/link";
import { Search } from "lucide-react";
import { PluginCard } from "../../components/plugin-card";
import { SiteFooter, SiteHeader } from "../../components/site-header";
import { getAvailableLocales, getCatalog, localizedPlugin, pluginSearchText, sortPlugins } from "../../lib/catalog";
import { categoryCopy, formatLocalizedDate, getCopy, localeHref, resolveLocale } from "../../lib/i18n";

export const revalidate = 300;

type SearchParams = Promise<{ q?: string; category?: string; lang?: string }>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const locale = resolveLocale((await searchParams).lang);
  return { title: getCopy(locale).marketplace.title, description: getCopy(locale).marketplace.description };
}

export default async function PluginsPage({ searchParams }: { searchParams: SearchParams }) {
  const catalog = await getCatalog();
  const availableLocales = getAvailableLocales(catalog);
  const params = await searchParams;
  const locale = resolveLocale(params.lang);
  const copy = getCopy(locale);
  const query = params.q?.trim() ?? "";
  const category = params.category ?? "all";
  const plugins = sortPlugins(catalog.plugins.filter((plugin) => {
    const localized = localizedPlugin(plugin, locale);
    const searchable = `${pluginSearchText(plugin)} ${pluginSearchText(localized)}`;
    const matchesQuery = !query || searchable.includes(query.toLowerCase());
    const matchesCategory = category === "all" || plugin.categories.includes(category);
    return matchesQuery && matchesCategory;
  }));
  const resultLabel = locale === "zh-CN" ? copy.marketplace.resultMany : plugins.length === 1 ? copy.marketplace.resultOne : copy.marketplace.resultMany;

  return <><SiteHeader locale={locale} availableLocales={availableLocales} /><main className="page-shell" lang={locale}><div className="container"><div className="page-heading"><div><p className="section-kicker">{copy.marketplace.kicker}</p><h1>{copy.marketplace.title}</h1><p>{copy.marketplace.description}</p></div><span className="catalog-date">{copy.marketplace.updated} {formatLocalizedDate(catalog.updatedAt, locale)}</span></div><form className="search-bar" action="/plugins" role="search"><Search size={18} /><label htmlFor="plugin-search" className="sr-only">{copy.marketplace.search}</label><input id="plugin-search" name="q" defaultValue={query} placeholder={copy.marketplace.searchPlaceholder} /><input type="hidden" name="lang" value={locale} /><button className="search-submit" type="submit">{copy.marketplace.search}</button></form><div className="filter-row" aria-label={copy.marketplace.kicker}>{Object.keys(copy.categories).map((id) => <Link className={`filter-chip ${category === id ? "active" : ""}`} href={localeHref(id === "all" ? "/plugins" : `/plugins?category=${id}${query ? `&q=${encodeURIComponent(query)}` : ""}`, locale)} key={id}>{categoryCopy(id, locale).label}</Link>)}</div><div className="catalog-result"><span>{plugins.length} {resultLabel}{query ? ` ${copy.marketplace.matching} “${query}”` : ""}</span><span>{copy.marketplace.packageNote}</span></div>{plugins.length ? <div className="catalog-grid">{plugins.map((plugin) => <PluginCard key={plugin.id} plugin={plugin} locale={locale} />)}</div> : <div className="empty-state"><strong>{copy.marketplace.emptyTitle}</strong>{copy.marketplace.emptyDescription}</div>}</div></main><SiteFooter locale={locale} availableLocales={availableLocales} /></>;
}
