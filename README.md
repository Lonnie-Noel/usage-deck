# Usage Deck

Desktop dashboard for local AI coding usage. The app reads ccusage JSON output and renders usage trends, model budgets, sessions, and active block data without sending local usage data anywhere.

## Stack

- Tauri 2 desktop shell
- React + TypeScript frontend
- Recharts for dashboard charts
- Zod runtime validation for ccusage JSON
- Pinned internal `ccusage@20.0.11`
- Tauri sidecar support for the pinned native ccusage binary

## Installation

Download the latest build from the [GitHub Releases page](https://github.com/Lonnie-Noel/usage-deck/releases).

Version `0.0.3` includes:

- Ubuntu x64 `.deb`: `Usage.Deck_0.0.3_amd64.deb`
- Ubuntu x64 AppImage: `Usage.Deck_0.0.3_amd64.AppImage`
- Windows x64 installer: `Usage.Deck_0.0.3_x64-setup.exe`
- macOS x64 app zip: `Usage.Deck_v0.0.3_macos-x64.app.zip`

Install the Ubuntu `.deb` package:

```bash
cd ~/Downloads
sudo apt install ./Usage.Deck_0.0.3_amd64.deb
```

Then launch `Usage Deck` from the Ubuntu app launcher. If Ubuntu asks for dependencies, keep using `apt install ./Usage.Deck_0.0.3_amd64.deb` instead of running the `.deb` file directly; `apt` resolves package dependencies for the local installer.

To remove the Ubuntu package:

```bash
sudo apt remove usage-deck
```

## Data Source Strategy

Usage Deck does not call `npx ccusage@latest` and does not require a global `ccusage` install for the default path.

The default `Bundled ccusage` mode first runs the Tauri sidecar:

```text
ccusage-runner daily --json
ccusage-runner monthly --json
ccusage-runner session --json
ccusage-runner blocks --json
```

The sidecar is copied from the pinned native binary distributed with `ccusage@20.0.11`.

In browser preview or when the sidecar has not been prepared, the app can fall back to the development runner:

```text
node resources/ccusage-runner/run-ccusage.mjs <command> --json
```

That runner locates the pinned local package at:

```text
node_modules/ccusage/dist/cli.js
```

Supported report commands:

```text
daily --json
monthly --json
session --json
blocks --json
```

The UI validates the returned JSON against the pinned ccusage report shapes before rendering. If the runner fails or the app is previewed outside Tauri, the dashboard falls back to mock data and shows diagnostics.

## Tray Indicator

Usage Deck includes a Tauri system tray indicator. The tray icon is rendered as one or two horizontal usage bars:

- One enabled bar renders as a larger single gauge for readability.
- Two enabled bars render as stacked gauges.
- Each bar can target a model family such as GPT/OpenAI or Claude, all models, or an exact model returned by ccusage.
- Each bar independently uses a weekly or monthly budget window, so the same model can appear twice with different budget periods.
- Colors default to model-aware colors, such as blue for GPT/OpenAI, orange for Claude, and purple for Gemini, and can be overridden per model.

Configure it in:

```text
Settings -> Tray Indicator
```

When a budget is not provided, the gauge falls back to a relative scale for the selected period. When a weekly or monthly budget is entered, the gauge displays usage against that configured budget.

Platform-specific tray rendering:

- Windows: dark rounded square icon for the notification area.
- macOS: transparent colored bars for the menu bar, with template rendering disabled so model colors remain visible.
- Ubuntu/Linux: dark capsule icon for AppIndicator/system tray surfaces.

On Windows and macOS, left-clicking the tray icon toggles the quick panel. Linux tray click events are desktop-environment dependent, so Ubuntu also exposes `Quick Panel` from the tray context menu.

## Development

Install dependencies:

```bash
npm install
```

Verify the internal ccusage runner:

```bash
npm run verify:ccusage
```

Prepare the Tauri sidecar for the current host:

```bash
npm run prepare:sidecar
```

Run the browser preview:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5174
```

Run as a Tauri app:

```bash
npm run tauri:dev
```

Build for macOS on a macOS host:

```bash
npm run tauri:build:mac
```

Build for Ubuntu x64 on an Ubuntu host:

```bash
npm run tauri:build:ubuntu
```

Ubuntu builds require the normal Tauri Linux system dependencies, including WebKitGTK, GTK, AppIndicator, and pkg-config packages. Cross-checking an Ubuntu target from macOS requires a Linux sysroot and cross-configured `pkg-config`; building on Ubuntu is the supported path for this MVP.

## Windows Packaging Notes

The Tauri project is configured for Windows `nsis` and `msi` targets. For a fully self-contained Windows x64 installer, build on a Windows x64 host and run:

```powershell
npm install
npm run tauri:build:windows
```

The build script copies the pinned native ccusage executable to the Tauri sidecar location:

```text
src-tauri/binaries/ccusage-runner-x86_64-pc-windows-msvc.exe
```

The native binary comes from `@ccusage/ccusage-win32-x64@20.0.11`, installed as an optional dependency of the pinned `ccusage` package. `USAGE_DECK_CCUSAGE_NATIVE_BINARY` can point to an explicit native binary if CI stores it elsewhere.

During development, `USAGE_DECK_CCUSAGE_RUNNER` can point to an explicit runner executable. If no sidecar is present, the app uses the pinned internal Node runner. That path is useful for browser preview and schema validation; packaged Windows builds should use the prepared sidecar so end users do not need Node.

## Checks

```bash
npm run typecheck
npm run build
npm run prepare:sidecar

cd src-tauri
cargo check
```

To verify the Tauri app binary on the current host without creating an installer:

```bash
npm run tauri -- build --no-bundle
```

Tauri installer builds require Rust and platform-specific Tauri prerequisites. Windows `nsis`/`msi` packaging should be run on a Windows build host.

Cross-checking the Windows MSVC target from macOS may stop before packaging if the local toolchain does not provide a Windows resource compiler such as `llvm-rc`. In that case, verify the Rust/Tauri build on the current host with `tauri -- build --no-bundle`, then run the Windows installer command on the Windows build host.
