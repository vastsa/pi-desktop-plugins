import Link from "next/link";
import { ArrowUpRight, Github } from "lucide-react";
import { BrandMark } from "./icons";
import { REPOSITORY_URL } from "../lib/catalog";
import { getCopy, localeHref, type Locale } from "../lib/i18n";
import { LanguageSwitcher } from "./language-switcher";

export function SiteHeader({ locale }: { locale: Locale }) {
  const copy = getCopy(locale);
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href={localeHref("/", locale)} className="brand" aria-label="PI-Desktop Plugins home">
          <BrandMark className="brand-mark" />
          <span>PI-Desktop <span className="brand-muted">Plugins</span></span>
        </Link>
        <nav className="desktop-nav" aria-label="Main navigation">
          <Link href={localeHref("/plugins", locale)}>{copy.nav.browse}</Link>
          <Link href={localeHref("/docs", locale)}>{copy.nav.build}</Link>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            {copy.nav.github} <ArrowUpRight size={14} />
          </a>
          <LanguageSwitcher locale={locale} label={copy.nav.language} />
        </nav>
        <div className="mobile-actions">
          <LanguageSwitcher locale={locale} label={copy.nav.language} />
          <a className="header-github" href={REPOSITORY_URL} target="_blank" rel="noreferrer" aria-label="Open GitHub repository">
            <Github size={17} />
          </a>
        </div>
      </div>
    </header>
  );
}

export function SiteFooter({ locale }: { locale: Locale }) {
  const copy = getCopy(locale);
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div>
          <Link href={localeHref("/", locale)} className="brand footer-brand">
            <BrandMark className="brand-mark" />
            <span>PI-Desktop Plugins</span>
          </Link>
          <p className="footer-copy">{copy.footer.description}</p>
        </div>
        <div className="footer-links">
          <Link href={localeHref("/plugins", locale)}>{copy.footer.marketplace}</Link>
          <Link href={localeHref("/docs", locale)}>{copy.footer.contributing}</Link>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">{copy.footer.source}</a>
          <LanguageSwitcher locale={locale} label={copy.nav.language} />
        </div>
      </div>
    </footer>
  );
}
