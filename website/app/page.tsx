import Link from "next/link";
import { ArrowRight, Check, ChevronRight, Code2, LockKeyhole, PackageCheck, Search } from "lucide-react";
import { PluginCard } from "../components/plugin-card";
import { PluginIcon } from "../components/icons";
import { SiteFooter, SiteHeader } from "../components/site-header";
import { categoryDescriptions, categoryLabels, featuredIds, getCatalog } from "../lib/catalog";

export const revalidate = 300;

export default async function HomePage() {
  const catalog = await getCatalog();
  const featured = featuredIds.map((id) => catalog.plugins.find((plugin) => plugin.id === id)).filter(Boolean);
  const categories = ["productivity", "developer-tools", "community", "official", "template"].map((id) => ({
    id,
    count: catalog.plugins.filter((plugin) => plugin.categories.includes(id)).length,
  }));

  return (
    <>
      <SiteHeader />
      <main>
        <section className="hero">
          <div className="container hero-grid">
            <div>
              <div className="eyebrow"><i className="eyebrow-dot" /> Official extension catalog</div>
              <h1>Make your workspace <span>more capable.</span></h1>
              <p className="hero-copy">Tools, panels, skills and workflows for PI-Desktop — built to stay close to your code and your machine.</p>
              <div className="hero-actions">
                <Link href="/plugins" className="button primary-button">Browse all plugins <ArrowRight size={16} /></Link>
                <Link href="/docs" className="button secondary-button">Build a plugin</Link>
              </div>
              <p className="hero-note">Open source packages · Explicit permissions · No account required</p>
            </div>
            <div className="terminal-card" aria-label="PI-Desktop plugin catalog preview">
              <div className="terminal-topbar"><div className="terminal-dots"><i /><i /><i /></div><span>pi-desktop / extensions</span><span>local</span></div>
              <div className="terminal-body">
                <div className="code-line"><span className="code-number">01</span><span><span className="code-keyword">const</span> workspace = <span className="code-string">&quot;your rules&quot;</span></span></div>
                <div className="code-line"><span className="code-number">02</span><span><span className="code-keyword">const</span> plugins = <span className="code-string">&quot;your choice&quot;</span></span></div>
                <div className="code-line"><span className="code-number">03</span><span className="code-muted">{"// extend without leaving your flow"}</span></div>
                <div className="workspace-preview">
                  <div className="preview-header"><span>Installed extensions</span><span className="preview-status"><i /> ready</span></div>
                  {["Git Lens", "Token Insights", "Todo List"].map((name, index) => <div className="preview-item" key={name}><span className="preview-icon"><Check size={15} /></span><strong>{name}</strong><span>{["git", "usage", "tasks"][index]}</span></div>)}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="stats-strip" aria-label="Catalog stats">
          <div className="container stats-grid">
            <div className="stat"><span className="stat-value">{catalog.plugins.length}</span><span className="stat-label">plugins in the catalog</span></div>
            <div className="stat"><span className="stat-value">{categories.length}</span><span className="stat-label">ways to find your fit</span></div>
            <div className="stat"><span className="stat-value">100%</span><span className="stat-label">reviewable package source</span></div>
            <div className="stat"><span className="stat-value">0</span><span className="stat-label">cloud accounts needed</span></div>
          </div>
        </section>

        <section className="section">
          <div className="container">
            <div className="section-header"><div><p className="section-kicker">Start here</p><h2>Useful from the first session.</h2><p className="section-intro">A small, focused catalog for the moments when your agent needs one more capability.</p></div><Link href="/plugins" className="text-link">View all plugins <ArrowRight size={15} /></Link></div>
            <div className="plugin-grid">{featured.map((plugin) => plugin && <PluginCard key={plugin.id} plugin={plugin} featured />)}</div>
          </div>
        </section>

        <section className="section" style={{ paddingTop: 0 }}>
          <div className="container">
            <div className="section-header"><div><p className="section-kicker">Explore by intent</p><h2>Find the right kind of help.</h2></div></div>
            <div className="category-grid">{categories.map(({ id, count }) => <Link href={`/plugins?category=${id}`} className="category-card" key={id}><div className="category-icon"><PluginIcon category={id} /></div><div><strong>{categoryLabels[id]}</strong><span>{count} {count === 1 ? "plugin" : "plugins"} · {categoryDescriptions[id]}</span></div><ChevronRight size={16} style={{ marginLeft: "auto", color: "var(--text-faint)" }} /></Link>)}</div>
          </div>
        </section>

        <section className="section trust-section">
          <div className="container"><p className="section-kicker">Designed for trust</p><h2>Keep the useful parts visible.</h2><p className="section-intro">Every plugin is inspectable before it enters your workspace. You decide what it can access.</p><div className="trust-grid"><div className="trust-item"><span className="trust-number">01 / SOURCE</span><h3><Code2 size={17} /> Open package source</h3><p>Read the manifest, README and implementation before installing a package from the official repository.</p></div><div className="trust-item"><span className="trust-number">02 / PERMISSIONS</span><h3><LockKeyhole size={17} /> Explicit capabilities</h3><p>Filesystem, network, shell and agent permissions are surfaced as part of the browse experience.</p></div><div className="trust-item"><span className="trust-number">03 / DELIVERY</span><h3><PackageCheck size={17} /> Simple package flow</h3><p>Download a versioned .piplug package, install it in PI-Desktop, then review the host permission prompt.</p></div></div></div>
        </section>

        <section className="cta-band"><div className="container cta-band-inner"><div><p className="section-kicker">For builders</p><h2>Build the extension your workflow is missing.</h2><p>The repository includes small examples and practical templates to help you go from idea to installable package.</p></div><Link href="/docs" className="button primary-button">Read the contribution guide <ArrowRight size={16} /></Link></div></section>
      </main>
      <SiteFooter />
    </>
  );
}
