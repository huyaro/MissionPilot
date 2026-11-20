import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Tauri serves the built frontend from the app bundle; no dev server port
  // assumptions in the built artifact.
  server: { port: 1420, strictPort: true },
  build: { outDir: 'dist' },
});
