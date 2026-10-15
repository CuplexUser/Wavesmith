// Builds the signed Android App Bundle to upload to Google Play.
// Usage: pnpm android:release (from web/)
//
// Checks the upload key setup first, so a missing or mistyped keystore.properties fails in a
// second instead of after the build. Then runs `pnpm android` (web build + cap sync) and
// `gradlew bundleRelease`, and prints the version and where the .aab landed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.join(root, 'web');
const android = path.join(web, 'android');
const propsFile = path.join(android, 'keystore.properties');
const gradleFile = path.join(android, 'app', 'build.gradle');
const aab = path.join(android, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** Reads a .properties file the way Gradle does for these simple key=value lines. */
function readProps(file) {
  const props = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([^#!=:\s]+)\s*[=:]\s*(.*?)\s*$/);
    if (m) props[m[1]] = m[2].replace(/\\(.)/g, '$1');
  }
  return props;
}

if (!fs.existsSync(propsFile)) {
  fail(
    'web/android/keystore.properties is missing, so the bundle would be unsigned.\n' +
      'Create it with storeFile, storePassword, keyAlias and keyPassword (see docs/android.md).',
  );
}
const props = readProps(propsFile);
const missing = ['storeFile', 'storePassword', 'keyAlias', 'keyPassword'].filter((k) => !props[k]);
if (missing.length) fail(`keystore.properties has no ${missing.join(', ')}.`);
// Gradle resolves a relative storeFile from the app module.
const storeFile = path.resolve(android, 'app', props.storeFile);
if (!fs.existsSync(storeFile)) {
  fail(
    `The upload key in keystore.properties was not found:\n  ${storeFile}\n` +
      'Use forward slashes in the path (C:/Users/...); backslashes are escapes in .properties files.',
  );
}

const gradle = fs.readFileSync(gradleFile, 'utf8');
const versionCode = gradle.match(/^\s*versionCode\s+(\d+)/m)?.[1] ?? '?';
const versionName = gradle.match(/^\s*versionName\s+"([^"]*)"/m)?.[1] ?? '?';
console.log(`Building Wavesmith ${versionName} (versionCode ${versionCode}), signed with ${path.basename(storeFile)}.`);

// Windows can only start .bat and .cmd files (gradlew.bat, pnpm.cmd) through a shell.
function run(cmd, cwd) {
  console.log(`> ${cmd}`);
  const r = spawnSync(cmd, { cwd, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run('pnpm android', web);
fs.rmSync(aab, { force: true });
// The explicit .\ matters: cmd.exe skips the current directory when NoDefaultCurrentDirectoryInExePath is set.
run(process.platform === 'win32' ? '.\\gradlew.bat bundleRelease' : './gradlew bundleRelease', android);

if (!fs.existsSync(aab)) fail(`Gradle finished but ${aab} is missing.`);
const mb = (fs.statSync(aab).size / 1024 / 1024).toFixed(1);
console.log(`
Wavesmith ${versionName} (versionCode ${versionCode}), ${mb} MB:
  ${aab}

Upload it in Play Console → Test and release → (track) → Create new release.
Before the next release, raise versionCode in web/android/app/build.gradle; Play rejects a code it has seen.`);
