# Notes for AI assistants working on this repo

This is an Electron wrapper + auto-updating launcher around a single-file HTML game (`game/game.html`, ~33 MB, Ukrainian UI). README.md has the user-facing picture. Read this before changing code.

## Ground rules
- **Never edit the game build from here.** The wrapper must play any build as-is. The game's own code lives in its `.html` (with its own changelog comment at the top; its first line `vNNN —` is how versions are detected).
- **The game origin is `app://game/` and must stay that.** localStorage (players' settings, known players, card images, coach marks) is keyed by origin; changing the scheme/host wipes everyone's data.
- **`latest.json` is a public contract** read by every installed launcher, including old ones. Only ever ADD optional fields; never rename or repurpose. `src/shared/manifest.js` is the parser; `scripts/release.js` is the writer.
- The updater (`src/main/updater.js`) must stay free of Electron imports: everything is injected so `test/updater.test.js` can run it against `test/helpers/fakeGithub.js`.
- Sandboxed preloads can't `require` project files. That's why `game-preload.js` inlines its own version compare.
- Launcher strings live in `src/launcher/i18n.js`: add every key to both `uk` and `en`. Main-process dialog strings are in `TEXT` in `main.js`.

## Verify changes
```bash
npm test                    # must stay green (also runs in the launcher-release Action on Windows)
xvfb-run -a npm run e2e     # real app + real game; writes screenshots to test-results/, look at them
```
Building the installer from Linux/macOS: `npm run dist:linux-host` (no Wine needed; see scripts/dist-from-linux.js). On Windows: `npm run dist`.

## Release mechanics
- Game release = a GitHub release whose tag is `vNNN` with the `.html`/`.zip` attached → `.github/workflows/game-release.yml` runs `scripts/release.js ci-game`, which uploads `pokemon_battle_vNNN.html.gz` + `latest.json` (carrying the previous `launcher` block forward).
- Carrying blocks forward: `previousManifestViaGh` keeps the HIGHEST game and launcher versions across recent releases' latest.json. Never "first in GitHub's list": that order is unreliable and once dropped the launcher block (v185). To repair a release's latest.json, run the "Game release" workflow by hand with its tag.
- Launcher release = the manual "Launcher release" workflow → builds on windows-latest with `app.config.json` pointed at the repo and the newest game bundled, uploads the installer + `latest.json` (carrying the `game` block forward), marks it latest.
- `game.history` (launcher 1.0.3+): the notes of the earlier game versions, newest first (up to 9), so "Що нового" can list the last 5 updates. `ci-game` builds it from the previous latest.json's game block + history and from the game blocks on recent releases (`gameHistory` in release.js), so releases made before history existed still count. Older launchers ignore it.
- A game build that needs new launcher features: publish it with `minLauncher` set (`scripts/release.js game … --min-launcher 1.1.0`). Older launchers then show "needs a newer launcher" instead of installing it.
- Launcher self-update runs electron-builder's one-click NSIS installer with `/S --updated [--force-run]`. Keep `nsis.oneClick: true` and `perMachine: false` (no UAC prompt), or that breaks.

## Phone version (web/, android/, scripts/build-web.js)
- The phone site is the game build + `web/mobile.js` injected by `scripts/build-web.js` (two string splices: tags after the real `<head>`, the add-on before the last `</body>`). The game file is still never edited.
- `web/mobile.js` must never change game state; it only reads globals (`S`, `MP`, `_loopAudio`, `hideArtTip`). Long press dispatches a synthetic `contextmenu` on the `[oncontextmenu]` element, then swallows the next click (render() replaces the element under the finger).
- `web/sw.js`: the page is cache-first under one key; updates are downloaded whole, version-checked, then swapped in. `version.json` is its contract with the site (and `android.version`/`url` for the APK notice). Only add fields.
- The Android app is a plain WebView shell (no Capacitor); it tags its user agent `PkmnAndroid/<version>`. `useWideViewPort` + `loadWithOverviewMode` are what make the viewport-width fit work; `setTextZoom(100)` keeps the phone's font size from breaking the board. It can't be built in the Claude sandbox (Google Maven is blocked): CI builds it.
- Verify: `npm test` and `GAME=path/to/build.html npm run test:web` (look at test-results/web/).
