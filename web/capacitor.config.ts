import type { CapacitorConfig } from '@capacitor/cli';

// The Android app wraps the Vite build. Assets ship inside the APK (no CDN, no fonts to
// fetch), so the game runs offline.
//
// appId is the Play Store package name and can never change after the first upload: replace
// it before publishing if you want a different one.
const config: CapacitorConfig = {
  appId: 'com.cuplex.wavesmith',
  appName: 'Wavesmith',
  webDir: 'dist',
  backgroundColor: '#070b14',
  android: {
    // WebAssembly and WebGL2 only; no mixed content or remote pages.
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 0 },
  },
};

export default config;
