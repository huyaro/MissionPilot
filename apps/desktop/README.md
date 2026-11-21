# MissionPilot — Tauri desktop app (P3)

The desktop board for the local orchestrator backend. React 19 + Vite
frontend inside a Tauri 2.x shell; the TypeScript backend runs as a
managed child process. Mac only is the target; this directory also builds
on Linux for verification.

## Run (dev)

Normal path — one command. The app starts its own backend on launch
(resolved backend JS, fresh token) and connects automatically; the Setup
screen only appears if that fails. After pulling new code, rebuild the
backend first from the repo root — `dist/` is a local build artifact and
`npm run tauri dev` does not rebuild it, so without this the app keeps
running the old backend:

```sh
npm run build        # repo root: rebuild backend into dist/
cd apps/desktop
npm run tauri dev
```

The frontend itself has two mutually exclusive ways — pick one, never both
at once. `npm run tauri dev` already starts its own Vite via
`beforeDevCommand`; running `npm run dev` alongside it fails with
"Port 1420 is already in use".

- `npm run tauri dev` — the Tauri app (normal path).
- `npm run dev` — frontend in the browser only (UI debugging, no Tauri
  shell); open http://localhost:1420.

To run the backend yourself instead (e.g. to attach a debugger), start it
in a terminal. The app then connects automatically if the token is in the
same shell's environment, otherwise paste it on the Setup screen:

```sh
cd ../..
ORCHESTRATOR_TRANSPORT=http ORCHESTRATOR_MCP_TOKEN=<token> node dist/src/server.js
```

The backend JS is resolved as: explicit path → packaged
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

Update (2026-11-20): the 9 -dev debs above are NOT enough to link anymore.
The link also needs `libatk1.0-dev libdbus-1-dev libsoup-3.0-dev
libjavascriptcoregtk-4.1-dev`, and the runtime `.so.0` files
(`libwebkit2gtk-4.1-0`, `libsoup-3.0-0`, `libjavascriptcoregtk-4.1-0`)
plus the webkit runtime dep closure (gstreamer1.0-plugins-base/good,
libgstreamer-plugins-base1.0-0, libgstreamer1.0-0, libsecret-1-0,
libmanette-0.2-0, … — compute with
`apt-cache depends --recurse --no-recommends … libwebkit2gtk-4.1-0 …`
and keep what `dpkg -s` says is not installed). Two gotchas:
`apt-get download` is ~12 kB/s here (slow mirror redirect) — direct
`curl` to `azure.archive.ubuntu.com` is ~20x faster; get exact pool paths
from `apt-cache show <pkg> | grep Filename` (webkit2gtk and libsoup3 are
in `universe`, not `main`). To RUN the built binary:
`LD_LIBRARY_PATH=/tmp/tauri-sysroot/usr/lib/x86_64-linux-gnu` plus a
symlink for the WebKit helpers:
`ln -s /tmp/tauri-sysroot/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1
/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1`.
Xvfb GUI smoke tests currently do NOT work in this image: a minimal
`eglGetDisplay` test fails with `EGL_BAD_PARAMETER`, so WebKit's
WebProcess never starts — the app shell stays alive but no page runs.
That is a VM graphics-stack limitation, not an app bug; verify GUI
behavior on the Mac.
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
