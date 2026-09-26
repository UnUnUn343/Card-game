# Бій покемонів: desktop app + phone app

**PC (Windows):** https://github.com/UnUnUn343/Card-game/releases
**Phones (iPhone + Android):** https://ununun343.github.io/Card-game/  ·  Android app: https://ununun343.github.io/Card-game/pokemon-battle.apk

The game as a Windows app, with a launcher that updates itself. The game itself is untouched. The app plays exactly the same `.html` you build, so online play, the bot, sounds, and saved settings all work as before.

```
 Launcher ──Play──► Game window
    │                   │
    └── checks GitHub ──┘  at start-up and every 30 min
        new game version  → downloads it, shows "Оновлено до v185!" (or a banner in-game)
        new launcher      → downloads the installer, updates itself on restart
```

## Players

1. Run `Pokemon-Battle-Setup-x.y.z.exe`. It installs for your Windows user (no admin needed) and adds a desktop and Start-menu shortcut.
   The installer isn't code-signed, so Windows may show **"Windows protected your PC"**. Click **More info → Run anyway**.
2. Press **ГРАТИ**. From then on, new versions arrive on their own.

| Key | Does |
|---|---|
| F11 or Alt+Enter | fullscreen on/off (the game starts fullscreen; ⚙ to change) |
| Esc | leave fullscreen |
| Ctrl + / Ctrl − / Ctrl 0 | zoom the game in / out / reset (remembered) |
| F12 | developer tools |

⚙ in the launcher: language (UA/EN), auto-download on/off, start fullscreen, skip the launcher, switch between installed versions (to roll back if a new one has a problem), install a build from a file.
You can also **drag any `.html` / `.zip` build onto the launcher** to install it. Handy for testing a build before you publish it.

Settings, installed versions and logs are in `%APPDATA%\Pokemon Battle\`.

## Phones

The same game build, on GitHub Pages, with a small add-on (`web/mobile.js`) injected at build time.
It lays the PC board out and scales it to fit a landscape phone screen, asks to turn the phone
sideways during a battle, turns a **long press into the right-click** (energy conversion), closes
card previews when you tap elsewhere, and pauses the music when the app goes to the background.

- **iPhone / iPad:** open the link in **Safari → Share → Add to Home Screen**. It then opens full screen, like an app.
- **Android:** open the link in Chrome and tap **Install** (or ⋮ → Add to Home screen), or install the APK:
  download `pokemon-battle.apk`, allow "Install unknown apps" for the browser when Android asks, and open it.
  The APK is a full-screen landscape shell around the same web app (no browser bars, screen stays on).
- **Updates:** the game is cached on the phone and works offline. When a new game version is published it
  downloads in the background, then shows **"Вийшла нова версія… Оновити"**. The Android app also says when a
  newer APK is out (rare: only when the Android shell itself changes).
- Saved data (settings, custom teams, card images) lives on each phone, separate from the PC.

## Publishing a new game version (you, every time)

1. On GitHub, open the repo → **Releases** → **Draft a new release**.
2. Tag: `v185` (the game version). Attach the game file (`.html` or the `.zip` it came in). Write what changed in the description (`- item`, `**bold**`, `## heading` all work).
3. **Publish release.**

That's it. A GitHub Action compresses the build and adds `latest.json` to the release (about a minute). Every launcher picks it up on its next check. Players see the notes in "Що нового". Anyone in a game gets a small banner, and nobody gets kicked out of a match.
Right after that, the **"Web and Android app"** Action rebuilds the phone site from the same build (a few minutes more), and phones get their "new version" banner.

Tick **"Set as a pre-release"** to publish a test build that players won't get. To try it yourself, paste that release's `latest.json` link into ⚙ → Update source.

## Publishing a new launcher version (rare: only when this app's code changes)

GitHub → **Actions** → **Launcher release** → **Run workflow**, then enter a version (e.g. `1.1.0`) and optional notes.
It builds the installer on Windows, bundles the newest game, publishes it, and every installed launcher updates itself (silently, next time it's closed or when the player clicks "Оновити зараз").
The installer to hand to new friends is on that release's page.

## Publishing a new Android app version (rare: only when `android/` changes)

Bump `def appVersion = '1.0.0'` in `android/app/build.gradle` and push. The "Web and Android app" Action
builds and signs the APK and puts it on the site; installed apps offer the download.
The signing key lives in 4 repo secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`). **Keep the backup copy of the key**: Android only installs an
update over the app if it's signed with the same key, so a lost key means everyone reinstalls.

## One-time setup

1. Create a GitHub repo (e.g. `pokemon-battle`). It must be **public** so launchers can download without a password.
   That also means anyone with the link can download the game.
2. Push this folder to it (`git init && git add . && git commit -m "Desktop app" && git push`).
3. Publish the current game as release `v184` (see above).
4. Run **Actions → Launcher release** with version `1.0.0`. The installer it produces is already pointed at your repo.

Launchers built before step 4 (like the one made by hand) can be pointed at the repo in ⚙ → Update source: type `your-name/pokemon-battle`.

## Development

Needs Node 22+.

```bash
npm install
npm run set-game -- path/to/pokemon_battle_v185.html   # or the .zip; bundles it as the built-in version
npm start                                              # run the app
npm run dev                                            # same, but keeps data in ./.dev-data
npx electron . --game=path/to/build.html               # play one file directly, skipping the launcher
npx electron . --feed=http://localhost:8080/latest.json   # test against another update feed
```

```bash
npm test          # unit tests: versions, zip/gz unpacking, store, downloader, updater, release tool, web build
npm run e2e       # drives the real app with the real game against a fake GitHub (on Linux: xvfb-run -a npm run e2e)
npm run dist      # build the Windows installer on Windows → dist/
npm run dist:linux-host   # same, from Linux/macOS
npm run icons     # re-render build/icon.png + icon.ico from build/icon.svg
npm run web -- --game path/to/build.html   # build the phone site → web-dist/
npm run test:web  # the phone site on emulated phones (fit, rotate, long press, offline, updates); GAME=… to pick a build
npm run android-icons   # re-render the Android launcher icons from build/icon.svg
```

### Layout

```
src/main/main.js          app start, windows, app://game/ protocol, IPC
src/main/updater.js       checks latest.json, downloads + verifies builds and installers
src/main/gameStore.js     installed game versions (bundled / downloaded / from file)
src/main/downloader.js    streaming download with SHA-256 check and retries
src/shared/               version compare, manifest format, .html/.gz/.zip unpacking
src/launcher/             the launcher screen (plain HTML/CSS/JS, strings in i18n.js)
src/preload/              the bridge for each window; game-preload.js draws the in-game update banner
scripts/release.js        builds latest.json; used by the GitHub Actions
scripts/build-web.js      builds the phone site from a game build (+ the APK when given)
web/                      mobile.js (the phone add-on injected into the page), sw.js (offline + updates)
android/                  the Android app: one Activity with a full-screen WebView (built by CI)
.github/workflows/        game-release.yml (on every release), launcher-release.yml (manual),
                          web-app.yml (phone site + APK → GitHub Pages)
test/                     unit tests, test/e2e/run.js, fake GitHub + fake gh CLI helpers
```

### How updates work

Every release carries a `latest.json`:

```json
{ "schema": 1,
  "game":     { "version": "185", "url": ".../pokemon_battle_v185.html.gz", "sha256": "…", "size": 24761088, "notes": "…", "minLauncher": null },
  "launcher": { "version": "1.1.0", "url": ".../Pokemon-Battle-Setup-1.1.0.exe", "sha256": "…", "size": 116973161 } }
```

The launcher reads `https://github.com/<repo>/releases/latest/download/latest.json`, which GitHub redirects to that file on the newest release. No API calls, no rate limits, no token. Downloads are checked against `sha256` before anything is installed. The game is served from `app://game/`, so saved data (localStorage) stays the same across versions.
