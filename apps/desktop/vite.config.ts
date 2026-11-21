import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri serves the built frontend from the app bundle; no dev server port
  // assumptions in the built artifact.
  // Pin the dev server to IPv4 loopback: Vite's default `localhost` can
  // bind IPv6-only ([::1]:1420), which the Tauri webview may not reach —
  // the app window then stays blank white while browsers still load fine.
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { outDir: 'dist' },
});
