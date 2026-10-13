import { defineConfig } from 'vitest/config';

// GitHub Pages serves the site from /<repo>/, so the base path is configurable.
// Local dev and Capacitor builds use the root.
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? (process.env.WAVESMITH_BASE ?? '/wavesmith/') : '/',
  server: {
    host: true,
    // Levels live in ../levels, outside the web root.
    fs: { allow: ['..'] },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
}));
