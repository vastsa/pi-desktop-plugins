import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Code2, LockKeyhole, PackageCheck } from "lucide-react";
import { PluginCard } from "../components/plugin-card";
import { PluginIcon } from "../components/icons";
import { SiteFooter, SiteHeader } from "../components/site-header";
import { featuredIds, getAvailableLocales, getCatalog } from "../lib/catalog";
import { categoryCopy, getCopy, localeHref, resolveLocale } from "../lib/i18n";

export const revalidate = 300;

type SearchParams = Promise<{ lang?: string }>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const locale = resolveLocale((await searchParams).lang);
  const copy = getCopy(locale);
  return { title: "PI-Desktop Plugins", description: copy.home.description };
}

export default async function HomePage({ searchParams }: { searchParams: SearchParams }) {
  const catalog = await getCatalog();
  const availableLocales = getAvailableLocales(catalog);
  const locale = resolveLocale((await searchParams).lang);
  const copy = getCopy(locale);
  const featured = featuredIds.map((id) => catalog.plugins.find((plugin) => plugin.id === id)).filter(Boolean);
  const categories = ["productivity", "developer-tools", "community", "official", "template"].map((id) => ({
    id,
    count: catalog.plugins.filter((plugin) => plugin.categories.includes(id)).length,
  }));

  return (
    <>
      <SiteHeader locale={locale} availableLocales={availableLocales} />
      <main lang={locale}>
        <section className="hero">
          <div className="container hero-grid">
            <div>
              <div className="eyebrow"><i className="eyebrow-dot" /> {copy.home.eyebrow}</div>
              <h1>{copy.home.titlePrefix} <span>{copy.home.titleAccent}</span></h1>
              <p className="hero-copy">{copy.home.description}</p>
              <div className="hero-actions">
                <Link href={localeHref("/plugins", locale)} className="button primary-button">{copy.home.browse} <ArrowRight size={16} /></Link>
                <Link href={localeHref("/docs", locale)} className="button secondary-button">{copy.home.build}</Link>
              </div>
              <p className="hero-note">{copy.home.note}</p>
            </div>
            <div className="terminal-card" aria-label="PI-Desktop plugin catalog preview">
              <div className="terminal-topbar"><div className="terminal-dots"><i /><i /><i /></div><span>pi-desktop / extensions</span><span>local</span></div>
              <div className="terminal-body">
                <div className="code-line"><span className="code-number">01</span><span><span className="code-keyword">const</span> workspace = <span className="code-string">&quot;your rules&quot;</span></span></div>
                <div className="code-line"><span className="code-number">02</span><span><span className="code-keyword">const</span> plugins = <span className="code-string">&quot;your choice&quot;</span></span></div>
                <div className="code-line"><span className="code-number">03</span><span className="code-muted">{"// extend without leaving your flow"}</span></div>
                <div className="workspace-preview">
                  <div className="preview-header"><span>{copy.home.previewTitle}</span><span className="preview-status"><i /> {copy.home.previewReady}</span></div>
                  {copy.home.previewNames.map((name, index) => <div className="preview-item" key={name}><span className="preview-icon"><Check size={15} /></span><strong>{name}</strong><span>{["git", "usage", "tasks"][index]}</span></div>)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="stats-strip" aria-label="Catalog stats">
          <div className="container stats-grid">
            <div className="stat"><span className="stat-value">{catalog.plugins.length}</span><span className="stat-label">{copy.home.stats[0]}</span></div>
            <div className="stat"><span className="stat-value">{categories.length}</span><span className="stat-label">{copy.home.stats[1]}</span></div>
            <div className="stat"><span className="stat-value">100%</span><span className="stat-label">{copy.home.stats[2]}</span></div>
            <div className="stat"><span className="stat-value">0</span><span className="stat-label">{copy.home.stats[3]}</span></div>
          </div>
        </section>

        <section className="section">
          <div className="container">
            <div className="section-header"><div><p className="section-kicker">{copy.home.startKicker}</p><h2>{copy.home.startTitle}</h2><p className="section-intro">{copy.home.startDescription}</p></div><Link href={localeHref("/plugins", locale)} className="text-link">{copy.home.viewAll} <ArrowRight size={15} /></Link></div>
            <div className="plugin-grid">{featured.map((plugin) => plugin && <PluginCard key={plugin.id} plugin={plugin} locale={locale} featured />)}</div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="section-header"><div><p className="section-kicker">{copy.home.exploreKicker}</p><h2>{copy.home.exploreTitle}</h2></div></div>
            <div className="category-grid">{categories.map(({ id, count }) => <Link href={localeHref(`/plugins?category=${id}`, locale)} className="category-card" key={id}><div className="category-icon"><PluginIcon category={id} /></div><div><strong>{categoryCopy(id, locale).label}</strong><span>{count} {count === 1 && locale === "en" ? copy.marketplace.resultOne : copy.marketplace.resultMany} · {categoryCopy(id, locale).description}</span></div><ChevronRight size={16} style={{ marginLeft: "auto", color: "var(--text-faint)" }} /></Link>)}</div>
          </div>
        </section>

        <section className="section trust-section">
          <div className="container"><p className="section-kicker">{copy.home.trustKicker}</p><h2>{copy.home.trustTitle}</h2><p className="section-intro">{copy.home.trustDescription}</p><div className="trust-grid">{copy.home.trustItems.map((item, index) => <div className="trust-item" key={item.number}><span className="trust-number">{item.number}</span><h3>{index === 0 ? <Code2 size={17} /> : index === 1 ? <LockKeyhole size={17} /> : <PackageCheck size={17} />} {item.title}</h3><p>{item.description}</p></div>)}</div></div>
        </section>

        <section className="cta-band"><div className="container cta-band-inner"><div><p className="section-kicker">{copy.home.builderKicker}</p><h2>{copy.home.builderTitle}</h2><p>{copy.home.builderDescription}</p></div><Link href={localeHref("/docs", locale)} className="button primary-button">{copy.home.builderButton} <ArrowRight size={16} /></Link></div></section>
      </main>
      <SiteFooter locale={locale} availableLocales={availableLocales} />
    </>
  );
}
