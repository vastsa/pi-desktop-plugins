"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { Locale } from "../lib/i18n";
import { localeHref } from "../lib/i18n";

export function LanguageSwitcher({ locale, label }: { locale: Locale; label: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const nextLocale: Locale = locale === "en" ? "zh-CN" : "en";
  const currentQuery = searchParams.toString();
  const currentPath = currentQuery ? `${pathname}?${currentQuery}` : pathname;

  return <Link className="language-switcher" href={localeHref(currentPath, nextLocale)} hrefLang={nextLocale === "en" ? "en" : "zh-CN"}>{label}</Link>;
}
