// Builds the Rust core to WebAssembly and generates the JS bindings in web/src/wasm.
// Usage: node scripts/build-wasm.mjs [--dev]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = !process.argv.includes('--dev');
const profile = release ? 'release' : 'debug';

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

run('cargo', [
  'build',
  '-p',
  'wavesmith-wasm',
  '--target',
  'wasm32-unknown-unknown',
  ...(release ? ['--release'] : []),
]);

const wasm = path.join(root, 'target', 'wasm32-unknown-unknown', profile, 'wavesmith_wasm.wasm');
const out = path.join(root, 'web', 'src', 'wasm');
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'wavesmith', wasm]);

// wasm-opt is optional; skip quietly when Binaryen isn't installed.
if (release) {
  const probe = spawnSync('wasm-opt', ['--version']);
  if (probe.status === 0) {
    const file = path.join(out, 'wavesmith_bg.wasm');
    run('wasm-opt', ['-O3', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '-o', file, file]);
  }
}
