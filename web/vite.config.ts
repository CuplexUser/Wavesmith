import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const sitePages: Record<string, string> = {
  features: page('features/index.html'),
  privacy: page('privacy/index.html'),
};

// GitHub Pages serves the site from /<repo>/, so the base path is configurable.
// Local dev and Capacitor builds use the root.
export default defineConfig(({ command, isPreview, mode }) => ({
  base: command === 'build' || isPreview ? (process.env.WAVESMITH_BASE ?? '/wavesmith/') : '/',
  server: {
    host: true,
    // Levels live in ../levels and the store screenshots in ../docs, outside the web root.
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rolldownOptions: {
      // The features and privacy pages ship with the web build next to the game. The Android
      // build (`--mode native`) leaves them and their screenshots out of the APK.
      input: { main: page('index.html'), ...(mode === 'native' ? {} : sitePages) },
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
}));
