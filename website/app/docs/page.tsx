import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Check, Code2, Package, ShieldCheck } from "lucide-react";
import { SiteFooter, SiteHeader } from "../../components/site-header";
import { getAvailableLocales, getCatalog, REPOSITORY_URL } from "../../lib/catalog";
import { getCopy, localeHref } from "../../lib/i18n";
import { getRequestLocale } from "../../lib/request-locale";

type SearchParams = Promise<{ lang?: string }>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const locale = await getRequestLocale((await searchParams).lang);
  return { title: getCopy(locale).docs.title, description: getCopy(locale).docs.description };
}

export default async function DocsPage({ searchParams }: { searchParams: SearchParams }) {
  const catalog = await getCatalog();
  const availableLocales = getAvailableLocales(catalog);
  const locale = await getRequestLocale((await searchParams).lang, availableLocales);
  const copy = getCopy(locale);
  return <><SiteHeader locale={locale} availableLocales={availableLocales} /><main className="page-shell" lang={locale}><div className="container" style={{ maxWidth: 860 }}><div className="breadcrumbs"><Link href={localeHref("/", locale)}><ArrowLeft size={14} /> {copy.docs.home}</Link><span>/</span><span>{copy.docs.title}</span></div><div className="page-heading" style={{ display: "block" }}><p className="section-kicker">{copy.docs.kicker}</p><h1>{copy.docs.title}</h1><p>{copy.docs.description}</p></div><div className="trust-grid docs-trust-grid"><div className="trust-item"><span className="trust-number">01</span><h3><Code2 size={17} /> {copy.docs.templateTitle}</h3><p>{copy.docs.templateDescription}</p></div><div className="trust-item"><span className="trust-number">02</span><h3><ShieldCheck size={17} /> {copy.docs.permissionTitle}</h3><p>{copy.docs.permissionDescription}</p></div><div className="trust-item"><span className="trust-number">03</span><h3><Package size={17} /> {copy.docs.packageTitle}</h3><p>{copy.docs.packageDescription}</p></div></div><article className="detail-content"><h2>{copy.docs.quickStart}</h2><pre><code>{`git clone https://github.com/<you>/pi-desktop-plugins.git\ncd pi-desktop-plugins\ncp -R plugins/demo.workspace-summary plugins/my.plugin-id\n\n# edit manifest.json, main.js and README.md\npython3 scripts/pack_plugin.py plugins/my.plugin-id\npython3 scripts/rebuild_catalog.py`}</code></pre><h2>{copy.docs.qualityTitle}</h2><ul>{copy.docs.qualityItems.map((item) => <li key={item}>{item}</li>)}</ul><h2>{copy.docs.submitTitle}</h2><p>{copy.docs.submitDescription}</p><p><a className="button primary-button" href={`${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`} target="_blank" rel="noreferrer">{copy.docs.readGuide} <ArrowUpRight size={15} /></a></p><h2>{copy.docs.localTitle}</h2><p>{copy.docs.localDescription}</p><div className="aside-card" style={{ marginTop: 28 }}><Check size={17} color="var(--green)" /><p className="safety-note" style={{ margin: "8px 0 0" }}>{copy.docs.sourceFirst}</p></div></article></div></main><SiteFooter locale={locale} availableLocales={availableLocales} /></>;
}
