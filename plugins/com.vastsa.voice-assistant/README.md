# Voice Assistant

Voice Assistant is a standalone third-party plugin for PI-Desktop. It adds a
voice and text panel that routes structured requests through the host's reviewed
desktop-operation catalog.

## Requirements

- PI-Desktop `>=0.8.0`
- A configured and authenticated PI-Desktop model
- A browser/runtime that provides microphone permission and, optionally,
  `SpeechRecognition` and `speechSynthesis`

The panel keeps text input available when browser speech recognition is not
supported.

## Install from a package

From a PI-Desktop checkout, validate and pack this directory:

```bash
pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build
node packages/plugin-devkit/dist/cli.js check plugins/com.vastsa.voice-assistant
node packages/plugin-devkit/dist/cli.js pack plugins/com.vastsa.voice-assistant
```

Then open **Plugins**, choose **Install plugin package**, select the generated
`.piplug` file, and review the requested permissions before enabling it.

This source directory is not copied into the application bundle. This repository
contains the standalone source and package release for the plugin.

## Permissions

- `ui.panel` opens the assistant panel.
- `ui.microphone` allows the panel to request audio input. It does not grant
  camera access.
- `agent.complete` routes the transcript through the selected PI-Desktop model.
- `models.list` lists available models for the settings panel.
- `desktop.control` exposes the reviewed operation catalog and its guarded
  invocation API.

The plugin never receives the local MCP bearer token, Electron channel names,
or direct access to the desktop IPC registry. Dangerous operations always show
a user confirmation card before the host is called.

## Settings

- **Voice model**: `providerId/modelId` used for routing.
- **Routing effort**: `minimal`, `low`, `medium`, or `high`.
- **Speak replies**: reads replies through the browser/system speech
  synthesizer when available.

The plugin does not add a network permission or a voice-provider API key. The
selected model request is handled by the PI-Desktop host through
`pi.agent.complete`.

## License

GNU Lesser General Public License v3.0. See [LICENSE](LICENSE).
