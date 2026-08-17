# PI-Desktop Plugins Web

The Vercel-ready marketplace and landing page for the PI-Desktop plugin
catalog.

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
- `/docs` — plugin author quick start and contribution link
