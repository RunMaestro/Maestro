// Ensure node_modules/electron has a working binary after install.
//
// Why this exists: electron's own postinstall (install.js) downloads the
// platform zip via @electron/get and then unpacks it with `extract-zip`
// (yauzl 2.x). On current Node 24 builds that extraction promise never
// settles - it hangs silently, the event loop drains, and Node exits 0
// WITHOUT writing electron's `path.txt`. The result is a half-installed
// electron: the download succeeds and caches the zip, but `require('electron')`
// throws "Electron failed to install correctly", which breaks the native-module
// smoke test and every test suite that imports electron.
//
// The download half works fine, so we reuse @electron/get to fetch (or cache-hit)
// the zip, then unpack it ourselves with the system `unzip`/`tar` instead of the
// hanging extract-zip path. Idempotent: a no-op when electron is already whole.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { downloadArtifact } = require('@electron/get');

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const electronDir = path.join(rootDir, 'node_modules', 'electron');

// electron isn't a dependency in every checkout (e.g. CLI-only installs); if the
// package isn't present there's nothing to repair.
if (!fs.existsSync(electronDir)) process.exit(0);

const { version } = require(path.join(electronDir, 'package.json'));

function getPlatformPath() {
	switch (process.platform) {
		case 'mas':
		case 'darwin':
			return 'Electron.app/Contents/MacOS/Electron';
		case 'freebsd':
		case 'openbsd':
		case 'linux':
			return 'electron';
		case 'win32':
			return 'electron.exe';
		default:
			throw new Error('Electron builds are not available on platform: ' + process.platform);
	}
}

const platformPath = getPlatformPath();
const distPath = path.join(electronDir, 'dist');
const pathTxt = path.join(electronDir, 'path.txt');

function isInstalled() {
	try {
		if (fs.readFileSync(path.join(distPath, 'version'), 'utf-8').replace(/^v/, '') !== version) {
			return false;
		}
		if (fs.readFileSync(pathTxt, 'utf-8') !== platformPath) return false;
	} catch {
		return false;
	}
	return fs.existsSync(path.join(distPath, platformPath));
}

if (isInstalled()) process.exit(0);

// Resolve the arch the same way electron's install.js does, including the
// rosetta-on-darwin case (x64 Node under translation still wants arm64).
let arch = process.env.npm_config_arch || process.arch;
if (process.platform === 'darwin' && arch === 'x64' && process.env.npm_config_arch === undefined) {
	try {
		const out = spawnSync('sysctl', ['-in', 'sysctl.proc_translated'], { encoding: 'utf8' });
		if ((out.stdout || '').trim() === '1') arch = 'arm64';
	} catch {
		// ignore - fall back to reported arch
	}
}

function unzip(zipPath, dir) {
	// Prefer `unzip` (mac/linux); fall back to bsdtar (`tar -xf`) which also reads
	// zip archives on macOS and Windows 10+. We deliberately avoid extract-zip.
	const unzipResult = spawnSync('unzip', ['-q', '-o', zipPath, '-d', dir], { stdio: 'inherit' });
	if (!unzipResult.error && unzipResult.status === 0) return;
	const tarResult = spawnSync('tar', ['-xf', zipPath, '-C', dir], { stdio: 'inherit' });
	if (!tarResult.error && tarResult.status === 0) return;
	throw new Error(
		`Failed to unpack ${zipPath}: unzip exited ${unzipResult.status}, tar exited ${tarResult.status}`
	);
}

const zipPath = await downloadArtifact({
	version,
	artifactName: 'electron',
	cacheRoot: process.env.electron_config_cache,
	checksums:
		process.env.electron_use_remote_checksums ||
		process.env.npm_config_electron_use_remote_checksums
			? undefined
			: require(path.join(electronDir, 'checksums.json')),
	platform: process.env.npm_config_platform || os.platform(),
	arch,
});

fs.rmSync(distPath, { recursive: true, force: true });
fs.mkdirSync(distPath, { recursive: true });
unzip(zipPath, distPath);

// install.js hoists the bundled type definitions up one level if present.
const srcTypeDef = path.join(distPath, 'electron.d.ts');
if (fs.existsSync(srcTypeDef)) {
	fs.renameSync(srcTypeDef, path.join(electronDir, 'electron.d.ts'));
}

fs.writeFileSync(pathTxt, platformPath);

if (!isInstalled()) {
	throw new Error('ensure-electron: electron still not correctly installed after manual unpack');
}

// eslint-disable-next-line no-console
console.log(`[maestro] ensure-electron: unpacked electron ${version} (${arch}) via system unzip`);
