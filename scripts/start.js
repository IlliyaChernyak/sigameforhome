/** Install native dependencies for this machine, then start the local server. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supervise } from './restart-policy.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modules = path.join(root, 'node_modules');
const stamp = path.join(modules, '.sigame-install');
const lockfile = path.join(root, 'package-lock.json');
const commandSuffix = process.platform === 'win32' ? '.cmd' : '';
const buildTools = ['vite', 'tsc', 'tsx'].map((name) => path.join(modules, '.bin', `${name}${commandSuffix}`));

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
// Vite 8 needs Node ^20.19.0 || >=22.12.0 to build the client.
const supported = (nodeMajor === 20 && nodeMinor >= 19) || (nodeMajor === 22 && nodeMinor >= 12) || nodeMajor > 22;
if (!supported) {
  console.error('Node.js 20.19+ or 22.12+ is required. Install it from https://nodejs.org.');
  process.exit(1);
}

// Native packages must be installed again if this checkout moves to another OS or CPU.
const fingerprint = [
  process.platform,
  process.arch,
  process.versions.modules,
  createHash('sha256').update(fs.readFileSync(path.join(root, 'package.json'))).digest('hex'),
  createHash('sha256').update(fs.readFileSync(lockfile)).digest('hex'),
].join(':');

if (!fs.existsSync(modules) || !fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== fingerprint ||
    buildTools.some((tool) => !fs.existsSync(tool))) {
  console.log('Installing dependencies for this platform...');
  // npm selects the native binaries for the current OS and CPU.
  const install = spawnSync('npm', ['install', '--include=dev', '--no-audit', '--no-fund'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.error || install.status !== 0) {
    console.error(install.error ?? 'Dependency installation failed.');
    process.exit(install.status || 1);
  }
  fs.writeFileSync(stamp, fingerprint);
}

// The server serves Vite's output, so build the browser bundle before listening.
const build = spawnSync('npm', ['run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.error || build.status !== 0) {
  console.error(build.error ?? 'Client build failed.');
  process.exit(build.status || 1);
}

// Seed the same pack directory the server will read when PACKS_DIR is overridden.
const packsDir = path.resolve(root, process.env.PACKS_DIR ?? 'packs');
fs.mkdirSync(packsDir, { recursive: true });
if (!fs.readdirSync(packsDir).some((name) => name.toLowerCase().endsWith('.siq'))) {
  // A fresh install should be playable before the host downloads a pack.
  const sample = spawnSync(process.execPath, ['--import', 'tsx', path.join(root, 'scripts', 'make-sample-pack.ts')], {
    cwd: root,
    stdio: 'inherit',
  });
  if (sample.error || sample.status !== 0) {
    console.error(sample.error ?? 'Sample pack generation failed.');
    process.exit(sample.status || 1);
  }
}
// One crash should not end the game night: restart it unless the stop was deliberate (audit CONN-1).
supervise({ command: process.execPath, args: ['--import', 'tsx', path.join(root, 'server', 'index.ts')], cwd: root });
