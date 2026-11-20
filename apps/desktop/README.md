# Orchestrator Board — Tauri desktop app (P3)

The desktop board for the local orchestrator backend. React 19 + Vite
frontend inside a Tauri 2.x shell; the TypeScript backend runs as a
managed child process. Mac only is the target; this directory also builds
on Linux for verification.

## Run (dev)

```sh
# Terminal 1 — backend in HTTP mode (token is yours to choose):
cd ../..
ORCHESTRATOR_TRANSPORT=http ORCHESTRATOR_MCP_TOKEN=<token> node dist/src/server.js

# Terminal 2 — frontend dev server (the app connects to 127.0.0.1:8788):
npm run dev
```

Or start the app and let it spawn the backend itself: the setup screen's
"Start backend" button runs `node <repo>/dist/src/server.js --http` with a
fresh token (Tauri command `start_backend`; the token comes back through
`get_token`). The backend JS is resolved as: explicit path → packaged
`<resource_dir>/backend/server.js` → dev layout
`../../../../dist/src/server.js` from the exe. Node comes from PATH.

## Build

```sh
npm run build        # tsc + vite → dist/
npm run tauri build  # Tauri bundle (needs the system deps below)
```

## Linux build deps (VM note)

The VM image's `libzstd1` is a `+hatch1` rebuild (1.5.5+dfsg2-2build1.1+hatch1),
which makes `libzstd-dev` (which requires exactly the stock
1.5.5+dfsg2-2build1.1) uninstallable — so `apt install
libwebkit2gtk-4.1-dev libgtk-3-dev …` fails with "held broken packages".
Do NOT downgrade libzstd1: it is a core library (systemd, apt, binutils
depend on it). Instead, build against an extracted sysroot (no system
mutation):

```sh
mkdir -p /tmp/tauri-sysroot-debs /tmp/tauri-sysroot
cd /tmp/tauri-sysroot-debs
apt-get download libayatana-appindicator3-dev libayatana-ido3-dev \
  libayatana-indicator3-dev libgdk-pixbuf-2.0-dev libgtk-3-dev \
  librsvg2-dev libtiff-dev libwebkit2gtk-4.1-dev libzstd-dev
for f in *.deb; do dpkg-deb -x "$f" /tmp/tauri-sysroot; done
find /tmp/tauri-sysroot -name '*.pc' -exec sed -i 's|^prefix=/usr$|prefix=/tmp/tauri-sysroot/usr|' {} +
# Re-point dangling .so symlinks at the real system libraries:
find /tmp/tauri-sysroot/usr/lib -type l | while read link; do
  target=$(readlink "$link"); case "$target" in /*) continue;; esac
  [ -e "$(dirname "$link")/$target" ] || ln -sf "/usr/lib/x86_64-linux-gnu/$target" "$link"
done
export PKG_CONFIG_PATH=/tmp/tauri-sysroot/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/lib/x86_64-linux-gnu/pkgconfig:/usr/share/pkgconfig
cargo check   # (in src-tauri/)
```

## Packaging gaps (known, for the Mac pass)

- App icon exists (`src-tauri/icons/icon.png`, generated placeholder: dark
  square + DAG mark). Replace with a final design before shipping the Mac .app.
- Node is taken from PATH, not bundled. The Mac .app should either bundle a
  node binary or document the node requirement.
- The backend JS is bundled at `<resource_dir>/backend/server.js` in the
  packaged app — the `tauri build` step must copy `../../dist/` there
  (not wired yet; the dev-layout fallback covers local runs).
- Mac signing/notarization is not set up.
