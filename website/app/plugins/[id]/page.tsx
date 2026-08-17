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
import { categoryLabels, currentVersion, formatBytes, formatDate, getCatalog, getPlugin, packageUrl, permissionRisk, REPOSITORY_URL } from "../../../lib/catalog";

export const revalidate = 300;

export async function generateStaticParams() {
  const catalog = await getCatalog();
  return catalog.plugins.map((plugin) => ({ id: plugin.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) return { title: "Plugin not found" };
  return { title: plugin.name, description: plugin.description };
}

export default async function PluginDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const plugin = await getPlugin(id);
  if (!plugin) notFound();
  const version = currentVersion(plugin);
  const permissions = version.permissions ?? [];
  const risk = permissionRisk(permissions);

  return <><SiteHeader /><main className="detail-shell"><div className="container"><div className="breadcrumbs"><Link href="/plugins"><ArrowLeft size={14} /> Plugins</Link><span>/</span><span>{plugin.name}</span></div><div className="detail-layout"><div><header className="detail-heading"><div className="detail-icon"><PluginIcon id={plugin.id} category={plugin.categories[0]} /></div><h1>{plugin.name}</h1><p>{plugin.description}</p><div className="detail-meta"><span>by <strong>{plugin.author}</strong></span><span>·</span><span>v{version.version}</span>{plugin.verified && <span className="verified-label"><Check size={13} /> Official catalog</span>}</div><div className="detail-actions"><a className="button primary-button" href={packageUrl(plugin)}><ArrowDownToLine size={16} /> Download .piplug</a><CopyPackageButton url={packageUrl(plugin)} /><a className="button secondary-button" href={plugin.homepage ?? `${REPOSITORY_URL}/tree/main/plugins/${plugin.id}`} target="_blank" rel="noreferrer">View source <ArrowUpRight size={15} /></a></div></header><article className="detail-content"><h2>About this plugin</h2>{plugin.readmeMarkdown ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{plugin.readmeMarkdown}</ReactMarkdown> : <p>No README is available yet. Visit the source repository for implementation details.</p>}</article></div><aside className="detail-aside"><div className="aside-card"><h2>Plugin facts</h2><div className="fact-row"><span>Latest version</span><strong>v{version.version}</strong></div><div className="fact-row"><span>Requires</span><strong>{version.minPiDesktop ?? "PI-Desktop"}</strong></div><div className="fact-row"><span>Package size</span><strong>{formatBytes(version.sizeBytes)}</strong></div><div className="fact-row"><span>Published</span><strong>{formatDate(version.publishedAt)}</strong></div><div className="fact-row"><span>Category</span><strong>{categoryLabels[plugin.categories[0]] ?? plugin.categories[0]}</strong></div></div><div className="aside-card"><h2>Permissions</h2><div style={{ marginBottom: 14 }}><PermissionBadge plugin={plugin} /></div>{permissions.length ? <div className="permission-list">{permissions.map((permission) => <span className="permission-name" key={permission}>{permission}</span>)}</div> : <p className="safety-note">No permissions declared.</p>}{risk.tone === "high" && <p className="safety-note" style={{ marginTop: 15 }}><strong><ShieldAlert size={14} /> Review before installing</strong>This plugin requests capabilities that may access your workspace, network or external applications.</p>}</div>{plugin.safetyNotes && <div className="aside-card safety-note"><strong>Safety notes</strong>{plugin.safetyNotes}</div>}<div className="aside-card"><h2>Install in PI-Desktop</h2><p className="safety-note">Download the package, then open <strong style={{ color: "var(--text)" }}>Plugins → Install .piplug</strong> and review the host permission prompt.</p><a className="text-link" href={packageUrl(plugin)}>Download package <ExternalLink size={14} /></a></div></aside></div></div></main><SiteFooter /></>;
}
