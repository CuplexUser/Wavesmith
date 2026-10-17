# Android release guide

The Android app is the Vite build wrapped with Capacitor (`web/android`). Everything that can
be prepared in the repository is done; this guide lists what needs your Google accounts, in
order. Android builds are made by hand on your machine and uploaded to Play by hand; no CI
workflow builds, signs or uploads the app.

## What is in place

| Piece | Where | Status |
| --- | --- | --- |
| Capacitor wrapper, offline assets (no CDN, system fonts) | `web/capacitor.config.ts`, `web/android/` | Done |
| Native haptics | `web/src/platform/native.ts` (`@capacitor/haptics`) | Done |
| Pause sim and audio in the background, resume cleanly | `createLifecycle` in `native.ts`, `PlayScreen` | Done |
| Android back button (dialog → screen → exit) | `App.back()` in `web/src/app.ts` | Done |
| Progress in native preferences, localStorage mirror | `createStorage` in `native.ts` | Done |
| One-time purchase that unlocks the full game | `BillingPlugin.java`, `web/src/platform/store.ts` | Needs the Play product |
| Play Games: sign-in, achievements, leaderboards, cloud save | `PlayGamesPlugin.java`, `web/src/platform/games.ts`, `res/values/game-ids.xml` | Needs Play Games setup |
| App icon (adaptive), splash screen | `web/assets/`, `android/app/src/main/res/` | Done |
| Store screenshots, feature graphic | `docs/store/` | Done (retake any time) |
| Trailer capture | `scripts/capture-trailer.mjs` | Script ready |
| Signed release AAB, built locally | `web/android/app/build.gradle`, `keystore.properties` | Needs the upload key |
| Web demo linking to the store | Level select banner, `PLAY_STORE_URL` in `store.ts` | Update the URL when live |

## 1. Package name

The app is `se.cuplex.wavesmith`, set in `web/capacitor.config.ts`, `web/android/app/build.gradle`
(`namespace`, `applicationId`), `res/values/strings.xml`, and the Java package folder. It can
never change once the app is uploaded to Play.

## 2. Build and run

Install Android Studio (it brings the SDK and a JDK; Gradle 9.1+ runs on JDK 21 through 25),
then:

```sh
cd web
pnpm install
pnpm wasm
pnpm android          # typecheck, Vite build with relative paths, cap sync into web/android
pnpm android:open     # open the project in Android Studio; Run ▶ on a phone or emulator
pnpm android:run      # build, sync and run on a connected device or emulator
pnpm android:release  # signed release bundle for Play (needs keystore.properties, see 3.)
```

Run `pnpm android` after every web or core change before building in Android Studio.

To build from the command line instead, point Gradle at the SDK once, either with `ANDROID_HOME`
or with an untracked `web/android/local.properties` (Android Studio writes it on first open):

```properties
sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk
```

Then `cd web/android && ./gradlew assembleDebug` writes `app/build/outputs/apk/debug/app-debug.apk`.

Debug builds work without any of the steps below. Play Games stays off and the purchase
button reports the store as unavailable until the Play Console parts exist.

## 3. Sign a release build

Create the upload key once, in Android Studio (**Build → Generate Signed App Bundle → Create
new**) or with `keytool`:

```sh
keytool -genkeypair -v -keystore wavesmith-upload.jks -alias upload \
  -keyalg RSA -keysize 4096 -validity 10000
```

Keep the key file and its passwords somewhere safe (a password manager), never in the
repository. Use Play App Signing (the default): Google holds the app signing key and this is
only the upload key, which Google can reset if you lose it.

Then make a release bundle either way:

- **Android Studio:** Build → Generate Signed App Bundle, pick the key, choose *release*.
- **Command line:** create `web/android/keystore.properties` (gitignored, like the key itself):

  ```properties
  storeFile=C:/path/to/wavesmith-upload.jks
  storePassword=...
  keyAlias=upload
  keyPassword=...
  ```

  `storeFile` is absolute or relative to `web/android/app` (use forward slashes). Then, from
  `web`, `pnpm android:release` checks the key setup, runs `pnpm android` and
  `gradlew bundleRelease`, and prints where `app-release.aab` landed.

Before each upload, raise `versionCode` (and `versionName`) in `web/android/app/build.gradle`;
Play rejects a bundle whose version code it has already seen.

## 4. Create the app in the Play Console

1. Play Console → Create app: name *Wavesmith*, game, paid features in-app (free download with
   an in-app purchase), declarations.
2. Fill in the store listing from `docs/store-listing.md`; upload `docs/store/*.jpg`
   (screenshots), `docs/store/feature-graphic.jpg`, and `web/assets/icon-only.png` resized to
   512×512 for the hi-res icon.
3. App content: privacy policy `https://cuplexuser.github.io/Wavesmith/privacy/` (the game
   collects nothing itself; Play Games and billing are Google's; Settings links to it), ads: none, content rating questionnaire, target audience, data safety (no data
   collected or shared by the app).
4. Upload the signed AAB to *Internal testing* (Testing → Internal testing → Create release).
   Play needs one upload before in-app products work. Later builds go up the same way, or to
   closed testing and production when you are ready.

## 5. The full-game purchase

1. Monetize → Products → In-app products → Create: product ID **`full_game`** (it must match
   `FULL_GAME_PRODUCT` in `web/src/platform/store.ts`), one-time, set the price, activate.
2. Add your Google account as a license tester (Settings → License testing) to buy without
   being charged.
3. Install from the internal track (the purchase only works for builds installed from Play),
   open a paid chapter, and buy. Reinstall and use *Restore purchase* in Settings to check
   that it comes back.

Which chapters are free is set per chapter by `"free"` in `levels/chapters.json`.

## 6. Play Games Services (optional for launch)

1. Play Console → Play Games Services → Setup → *No, my game doesn't use Google APIs* → create.
2. Credentials → create an Android OAuth credential with the package name and the **SHA-1 of
   the app signing key** (Play Console → Setup → App signing) and, for local debug builds, the
   SHA-1 of your debug key (`./gradlew signingReport`).
3. Create the achievements and leaderboards below, then paste the console's export
   (Achievements or Leaderboards → *Get resources* → Android) over
   `web/android/app/src/main/res/values/game-ids.xml`. It carries the project ID (`app_id`)
   and every ID. The console names each entry after its title (*First Ripple* becomes
   `achievement_first_ripple`), so the titles must match the **Name** columns exactly; the game
   finds them through `ACHIEVEMENTS` and `LEADERBOARDS` in `web/src/platform/games.ts`, and
   `test/games.test.ts` fails if an achievement is missing from the file.
4. Achievements → create these:

   | Key | Name | Description |
   | --- | --- | --- |
   | `first-solve` | First Ripple | Solve any level. |
   | `chapter-1` | Reflection | Solve every level in Chapter 1. |
   | `chapter-2` | Interference | Solve every level in Chapter 2. |
   | `chapter-3` | Resonance | Solve every level in Chapter 3. |
   | `chapter-4` | Refraction | Solve every level in Chapter 4. |
   | `chapter-5` | Light | Solve every level in Chapter 5. |
   | `chapter-6` | Doppler | Solve every level in Chapter 6. |
   | `chapter-N-stars` | (Chapter) Mastered | Earn all three stars on every level of chapter N. |
   | `all-stars` | Wavesmith | Earn every star in the game. |

5. Leaderboards → create this one, with the icon `leaderboard-icon-512.png`, then export
   again so `leaderboard_total_stars` lands in `game-ids.xml`:

   | Name | Format | Order | Limits |
   | --- | --- | --- | --- |
   | Total Stars | Numeric, no decimals | Larger is better | 0 to 3 × the number of levels (84 for 28 levels) |

   The game submits the player's star total whenever it goes up and at sign-in. Settings shows
   a *Leaderboards* button next to *Achievements* once the player is signed in.
6. Turn on *Saved games* (Configuration) for the cloud save.
7. Add testers (Configuration → Testers) until Play Games is published.

Without `app_id` in `game-ids.xml` the build fails, because the manifest refers to it.

## 7. Before the "web is good enough" gate passes

The roadmap's gate still needs real devices: 60 fps on a mid-range Android phone, touch and
haptics checked by hand, and outside playtesters. Turn on *Performance stats* in Settings (or
press P) to read frame rate, solver cost, and whether the slow-motion badge appears.
