// Builds the Rust core to WebAssembly and generates the JS bindings in web/src/wasm.
// Usage: node scripts/build-wasm.mjs [--dev] [--if-stale]
//
// --if-stale skips the build when web/src/wasm was built from the current Rust sources (a
// hash of crates/**, Cargo.toml, and Cargo.lock is kept next to the output). `pnpm dev` and
// `pnpm build` use it, so a pull that changes the core can't leave an old build running.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = !process.argv.includes('--dev');
const profile = release ? 'release' : 'debug';
const stampFile = path.join(root, 'web', 'src', 'wasm', '.source-hash');

/** Hash of everything the WebAssembly is built from. */
function sourceHash() {
  const files = [path.join(root, 'Cargo.toml'), path.join(root, 'Cargo.lock')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'target') walk(p);
      } else if (/\.(rs|toml)$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(root, 'crates'));
  const h = createHash('sha256');
  h.update(profile);
  for (const f of files.sort()) {
    h.update(path.relative(root, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex');
}

const hash = sourceHash();
if (process.argv.includes('--if-stale')) {
  const built = fs.existsSync(path.join(root, 'web', 'src', 'wasm', 'wavesmith_bg.wasm'));
  const stamp = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf8').trim() : '';
  if (built && stamp === hash) process.exit(0);
  console.log(built ? 'Rust core changed; rebuilding the WebAssembly.' : 'Building the WebAssembly core.');
}

function run(cmd, args, env = process.env) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

// SIMD lets the solver loop vectorize across cells. Results stay bit-identical to the native
// build: lanes compute the same IEEE operations in the same order per cell.
run(
  'cargo',
  ['build', '-p', 'wavesmith-wasm', '--target', 'wasm32-unknown-unknown', ...(release ? ['--release'] : [])],
  { ...process.env, RUSTFLAGS: `${process.env.RUSTFLAGS ?? ''} -C target-feature=+simd128`.trim() },
);

const wasm = path.join(root, 'target', 'wasm32-unknown-unknown', profile, 'wavesmith_wasm.wasm');
const out = path.join(root, 'web', 'src', 'wasm');
run('wasm-bindgen', ['--target', 'web', '--out-dir', out, '--out-name', 'wavesmith', wasm]);

// wasm-opt comes from the `binaryen` dev dependency (pnpm puts it on PATH for scripts), so CI
// and local builds optimize the same way. Run directly with node, it is used if found.
if (release) {
  const probe = spawnSync('wasm-opt', ['--version']);
  if (probe.status !== 0) {
    console.warn('wasm-opt not found; the WebAssembly will be about 50% larger. Run via `pnpm wasm`.');
  } else {
    const file = path.join(out, 'wavesmith_bg.wasm');
    run('wasm-opt', ['-O3', '--enable-simd', '--enable-bulk-memory', '--enable-nontrapping-float-to-int', '-o', file, file]);
  }
}

fs.writeFileSync(stampFile, `${hash}\n`);
