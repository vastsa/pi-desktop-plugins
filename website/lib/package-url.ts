export function resolvePackageUrl(url: string, catalogUrl: string, artifactBaseUrl?: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const base = artifactBaseUrl?.trim();
  if (!base) return new URL(url, catalogUrl).toString();
  return new URL(url.replace(/^\/+/, ""), base.endsWith("/") ? base : `${base}/`).toString();
}
