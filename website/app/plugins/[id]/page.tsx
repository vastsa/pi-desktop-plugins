import type { Metadata } from "next";
import Link from "next/link";
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Check, ExternalLink, ShieldAlert } from "lucide-react";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyPackageButton } from "../../../components/copy-package-button";
import { PluginIcon } from "../../../components/icons";
import { PermissionBadge } from "../../../components/plugin-card";
import { SiteFooter, SiteHeader } from "../../../components/site-header";
import { currentVersion, formatBytes, getCatalog, getPlugin, localizedPlugin, packageUrl, permissionRisk, REPOSITORY_URL } from "../../../lib/catalog";
import { categoryCopy, formatLocalizedDate, getCopy, localeHref, resolveLocale } from "../../../lib/i18n";

export const revalidate = 300;

export async function generateStaticParams() {
  const catalog = await getCatalog();
  return catalog.plugins.map((plugin) => ({ id: plugin.id }));
}

export async function generateMetadata({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string }> }): Promise<Metadata> {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) return { title: "Plugin not found" };
  const locale = resolveLocale((await searchParams).lang);
  const localized = localizedPlugin(plugin, locale);
  return { title: localized.name, description: localized.description };
}

export default async function PluginDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) notFound();
  const locale = resolveLocale((await searchParams).lang);
  const copy = getCopy(locale);
  const localized = localizedPlugin(plugin, locale);
  const version = currentVersion(plugin);
  const permissions = version.permissions ?? [];
  const risk = permissionRisk(permissions);
  const packageHref = packageUrl(plugin);

  return <><SiteHeader locale={locale} /><main className="detail-shell" lang={locale}><div className="container"><div className="breadcrumbs"><Link href={localeHref("/plugins", locale)}><ArrowLeft size={14} /> {copy.detail.plugins}</Link><span>/</span><span>{localized.name}</span></div><div className="detail-layout"><div><header className="detail-heading"><div className="detail-icon"><PluginIcon id={plugin.id} category={plugin.categories[0]} /></div><h1>{localized.name}</h1><p>{localized.description}</p><div className="detail-meta"><span>{copy.detail.by} <strong>{plugin.author}</strong></span><span>·</span><span>v{version.version}</span>{plugin.verified && <span className="verified-label"><Check size={13} /> {copy.detail.catalogOfficial}</span>}</div><div className="detail-actions"><a className="button primary-button" href={packageHref}><ArrowDownToLine size={16} /> {copy.detail.download}</a><CopyPackageButton url={packageHref} locale={locale} /><a className="button secondary-button" href={plugin.homepage ?? `${REPOSITORY_URL}/tree/main/plugins/${plugin.id}`} target="_blank" rel="noreferrer">{copy.detail.source} <ArrowUpRight size={15} /></a></div></header><article className="detail-content"><h2>{copy.detail.about}</h2>{localized.readmeMarkdown ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{localized.readmeMarkdown}</ReactMarkdown> : <p>{copy.detail.noReadme}</p>}</article></div><aside className="detail-aside"><div className="aside-card"><h2>{copy.detail.facts}</h2><div className="fact-row"><span>{copy.detail.latestVersion}</span><strong>v{version.version}</strong></div><div className="fact-row"><span>{copy.detail.requires}</span><strong>{version.minPiDesktop ?? "PI-Desktop"}</strong></div><div className="fact-row"><span>{copy.detail.packageSize}</span><strong>{formatBytes(version.sizeBytes)}</strong></div><div className="fact-row"><span>{copy.detail.published}</span><strong>{formatLocalizedDate(version.publishedAt, locale)}</strong></div><div className="fact-row"><span>{copy.detail.category}</span><strong>{categoryCopy(plugin.categories[0], locale).label}</strong></div></div><div className="aside-card"><h2>{copy.detail.permissions}</h2><div style={{ marginBottom: 14 }}><PermissionBadge plugin={plugin} locale={locale} /></div>{permissions.length ? <div className="permission-list">{permissions.map((permission) => <span className="permission-name" key={permission}>{permission}</span>)}</div> : <p className="safety-note">{copy.detail.noPermissions}</p>}{risk.tone === "high" && <p className="safety-note" style={{ marginTop: 15 }}><strong><ShieldAlert size={14} /> {copy.detail.reviewTitle}</strong>{copy.detail.reviewDescription}</p>}</div>{localized.safetyNotes && <div className="aside-card safety-note"><strong>{copy.detail.safetyNotes}</strong>{localized.safetyNotes}</div>}<div className="aside-card"><h2>{copy.detail.installTitle}</h2><p className="safety-note">{copy.detail.installDescription}</p><a className="text-link" href={packageHref}>{copy.detail.downloadPackage} <ExternalLink size={14} /></a></div></aside></div></div></main><SiteFooter locale={locale} /></>;
}
