import { cookies, headers } from "next/headers";
import { localeCookieName, resolveRequestLocale, type Locale } from "./i18n";

export async function getRequestLocale(requested: unknown, availableLocales?: readonly string[]): Promise<Locale> {
  const requestHeaders = await headers();
  const requestCookies = await cookies();

  return resolveRequestLocale({
    requested,
    persisted: requestCookies.get(localeCookieName)?.value,
    acceptLanguage: requestHeaders.get("accept-language"),
    availableLocales,
  });
}
