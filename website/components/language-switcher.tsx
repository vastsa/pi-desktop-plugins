"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Locale } from "../lib/i18n";
import { localeCookieName, localeHref, localeLabel } from "../lib/i18n";

export function LanguageSwitcher({ locale, label, availableLocales }: { locale: Locale; label: string; availableLocales: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentQuery = searchParams.toString();
  const currentPath = currentQuery ? `${pathname}?${currentQuery}` : pathname;
  const options = Array.from(new Set([...availableLocales, locale]));

  const handleChange = (nextLocale: string) => {
    document.cookie = `${localeCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.push(localeHref(currentPath, nextLocale, { includeDefault: true }));
  };

  return <select className="language-switcher" aria-label={label} value={locale} onChange={(event) => handleChange(event.target.value)}>
    {options.map((option) => <option key={option} value={option}>{localeLabel(option)}</option>)}
  </select>;
}
