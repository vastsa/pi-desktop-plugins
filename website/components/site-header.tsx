import Link from "next/link";
import { ArrowUpRight, Github } from "lucide-react";
import { BrandMark } from "./icons";
import { REPOSITORY_URL } from "../lib/catalog";

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="PI-Desktop Plugins home">
          <BrandMark className="brand-mark" />
          <span>PI-Desktop <span className="brand-muted">Plugins</span></span>
        </Link>
        <nav className="desktop-nav" aria-label="Main navigation">
          <Link href="/plugins">Browse plugins</Link>
          <Link href="/docs">Build a plugin</Link>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">
            GitHub <ArrowUpRight size={14} />
          </a>
        </nav>
        <a className="header-github" href={REPOSITORY_URL} target="_blank" rel="noreferrer" aria-label="Open GitHub repository">
          <Github size={17} />
        </a>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div>
          <Link href="/" className="brand footer-brand">
            <BrandMark className="brand-mark" />
            <span>PI-Desktop Plugins</span>
          </Link>
          <p className="footer-copy">A calm, local-first extension catalog for PI-Desktop.</p>
        </div>
        <div className="footer-links">
          <Link href="/plugins">Marketplace</Link>
          <Link href="/docs">Contributing</Link>
          <a href={REPOSITORY_URL} target="_blank" rel="noreferrer">Source code</a>
        </div>
      </div>
    </footer>
  );
}
