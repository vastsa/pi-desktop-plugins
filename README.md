# PI-Desktop Plugins

Official plugin marketplace repository for [PI-Desktop](https://github.com/vastsa/PI-Desktop).

## Layout

```text
catalog.json                 # marketplace index consumed by PI-Desktop
packages/*.piplug            # installable plugin packages
plugins/<id>/                # plugin sources
scripts/                     # maintain / pack helpers
```

## How PI-Desktop uses this repo

1. Host fetches `catalog.json` from the official provider URL
2. UI shows browse/search results from that catalog
3. Install downloads the referenced `.piplug`
4. Host verifies `shasum` before enabling the plugin

Default catalog URL:

```text
https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json
```

## Maintain a plugin

```bash
# 1) edit sources under plugins/<id>
# 2) pack + refresh catalog
python3 scripts/pack_plugin.py plugins/demo.hello
python3 scripts/rebuild_catalog.py
```

## Package constraints

- Root must contain `manifest.json`
- No symlinks / path traversal
- Store-compressed zip packaged as `.piplug`
- Max package size 50MB

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

Practical template:

```bash
cp -R plugins/demo.workspace-summary plugins/my.plugin-id
python3 scripts/pack_plugin.py plugins/my.plugin-id
python3 scripts/rebuild_catalog.py
```

