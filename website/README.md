# PI-Desktop Plugins Web

The Vercel-ready marketplace and landing page for the PI-Desktop plugin
catalog.

Plugin sources are not hosted in this repository. Authoring and releasing happen
on the plugin center, <https://plugins.aiuo.net>; this site only renders the
catalog and links every plugin to its center page.

## Local development

```bash
pnpm install --ignore-scripts
pnpm dev
```

Open <http://localhost:3000>.

The site reads the official catalog from:

```text
https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json
```

Catalog responses are revalidated every five minutes. Set `CATALOG_URL` to
use a different catalog provider during preview or development.

Package downloads use the catalog's `artifactBaseUrl` when it is present, and
otherwise resolve relative to `CATALOG_URL`. Run `pnpm test` with Node.js 22.6 or
later to check URL resolution.

The site defaults to English and uses `?lang=<locale>` for language selection.
When no explicit language is present, it matches the browser's
`Accept-Language` header against the locales available in the catalog. A manual
selection is stored in the `pi-desktop-locale` cookie and takes priority on
future visits.
The language picker is discovered from the site dictionaries and every locale
key present in the catalog, so adding a plugin translation such as `ja` or
`de-DE` makes that locale available without changing the picker. Internal links
preserve the selected language. Untranslated site copy falls back to English;
plugin names, descriptions and safety notes fall back in this order: requested
locale, English, Simplified Chinese, then the default manifest fields.

## Vercel deployment

Create a Vercel project from this repository and set the project root to:

```text
website
```

Vercel detects Next.js automatically. No database, API key, or build-time
secret is required.

The production build can be checked locally with:

```bash
pnpm build
pnpm start
```

## Routes

- `/` — landing page
- `/plugins` — searchable and filterable catalog
- `/plugins/<id>` — plugin details, permissions, README and package download
- `/docs` — plugin author quick start and a link to the plugin center

The page copy points authors at the plugin center: `/docs` starts from the
built-in templates and the devkit CLI (`pi-plugin init/check/pack`) and links
straight to the center, where versions are submitted.
