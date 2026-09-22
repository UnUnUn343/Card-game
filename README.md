# Бій покемонів: desktop app

**Download the game / all versions:** https://github.com/UnUnUn343/Card-game/releases

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

## Publishing a new game version (you, every time)

1. On GitHub, open the repo → **Releases** → **Draft a new release**.
2. Tag: `v185` (the game version). Attach the game file (`.html` or the `.zip` it came in). Write what changed in the description (`- item`, `**bold**`, `## heading` all work).
3. **Publish release.**

That's it. A GitHub Action compresses the build and adds `latest.json` to the release (about a minute). Every launcher picks it up on its next check. Players see the notes in "Що нового". Anyone in a game gets a small banner, and nobody gets kicked out of a match.

Tick **"Set as a pre-release"** to publish a test build that players won't get. To try it yourself, paste that release's `latest.json` link into ⚙ → Update source.

## Publishing a new launcher version (rare: only when this app's code changes)

GitHub → **Actions** → **Launcher release** → **Run workflow**, then enter a version (e.g. `1.1.0`) and optional notes.
It builds the installer on Windows, bundles the newest game, publishes it, and every installed launcher updates itself (silently, next time it's closed or when the player clicks "Оновити зараз").
The installer to hand to new friends is on that release's page.

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
npm test          # unit tests: versions, zip/gz unpacking, store, downloader, updater, release tool (35)
npm run e2e       # drives the real app with the real game against a fake GitHub (on Linux: xvfb-run -a npm run e2e)
npm run dist      # build the Windows installer on Windows → dist/
npm run dist:linux-host   # same, from Linux/macOS
npm run icons     # re-render build/icon.png + icon.ico from build/icon.svg
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
.github/workflows/        game-release.yml (on every release), launcher-release.yml (manual)
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
