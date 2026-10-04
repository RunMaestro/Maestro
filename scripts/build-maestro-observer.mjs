#!/usr/bin/env node
/**
 * Build script for `maestro-observer`, the Rust accessibility helper behind
 * the Computer History plugin (native/maestro-observer).
 *
 * Usage:
 *   node scripts/build-maestro-observer.mjs                 # host platform + arch
 *   node scripts/build-maestro-observer.mjs --arch arm64    # host platform, other arch
 *   node scripts/build-maestro-observer.mjs --target x86_64-unknown-linux-gnu
 *   node scripts/build-maestro-observer.mjs --universal     # macOS: lipo x64 + arm64
 *   node scripts/build-maestro-observer.mjs --debug         # unoptimized build
 *
 * Output: dist/native/<platform>-<arch>/maestro-observer[.exe], where platform
 * is darwin | win32 | linux and arch is x64 | arm64 (Node naming, matching
 * electron-builder's ${arch}). `--universal` writes the fat binary to
 * darwin-universal, darwin-x64, and darwin-arm64 so any packaging mode finds
 * it. electron-builder copies dist/native/<platform>-${arch}/ to
 * <resources>/native/, so the packaged binary lives at
 * process.resourcesPath/native/maestro-observer[.exe].
 *
 * Not part of `npm run build`: contributors without Rust can still build and
 * package the app (it just ships without the helper). The release workflow
 * calls this script explicitly for every platform and arch.
 *
 * Toolchain: when rustup is installed, the rustup-managed cargo/rustc are used
 * (`rustup which`), because a Homebrew `rust` earlier on PATH has no
 * cross-compilation targets. Otherwise plain `cargo` from PATH. Cargo runs
 * from the crate directory so native/maestro-observer/.cargo/config.toml
 * applies (static CRT on Windows, so no VC++ redistributable is needed).
 *
 * Signing (what happens downstream, not here):
 * - macOS: `electron-builder --mac` signs every Mach-O under
 *   Contents/Resources with hardened runtime and `mac.entitlementsInherit`
 *   (build/entitlements.mac.plist). electron-builder 26 has no per-binary
 *   entitlements (getOptionsForFile only distinguishes the main app, login
 *   items, and everything else), so the helper inherits that plist. The
 *   helper needs no entitlements for AX; the inherited ones (JIT, unsigned
 *   executable memory, library validation off, Apple Events) grant nothing by
 *   themselves and Apple Events stay TCC-gated. A dedicated minimal plist
 *   would need `signIgnore` plus pre-signing here with the release identity;
 *   not done yet. TCC attributes the Accessibility grant to the responsible
 *   process (Maestro.app), so users grant Maestro, not the helper.
 * - Windows: unsigned, like the rest of the Windows build today.
 * - Linux: no signing.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const crateDir = path.join(rootDir, 'native/maestro-observer');
const outRoot = path.join(rootDir, 'dist/native');
const BIN = 'maestro-observer';

/** Node platform + arch -> Rust target triple. */
const TRIPLES = {
	'darwin-x64': 'x86_64-apple-darwin',
	'darwin-arm64': 'aarch64-apple-darwin',
	'win32-x64': 'x86_64-pc-windows-msvc',
	'win32-arm64': 'aarch64-pc-windows-msvc',
	'linux-x64': 'x86_64-unknown-linux-gnu',
	'linux-arm64': 'aarch64-unknown-linux-gnu',
};

function fail(message) {
	console.error(`build-maestro-observer: ${message}`);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { target: null, arch: null, universal: false, debug: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--target') opts.target = argv[++i];
		else if (arg === '--arch') opts.arch = argv[++i];
		else if (arg === '--universal') opts.universal = true;
		else if (arg === '--debug') opts.debug = true;
		else if (arg === '--help' || arg === '-h') {
			console.log(
				'usage: node scripts/build-maestro-observer.mjs [--target <triple> | --arch x64|arm64 | --universal] [--debug]'
			);
			process.exit(0);
		} else fail(`unknown argument: ${arg}`);
	}
	if (opts.arch && !['x64', 'arm64'].includes(opts.arch)) {
		fail(`--arch must be x64 or arm64, got ${opts.arch}`);
	}
	if ([opts.target, opts.arch, opts.universal].filter(Boolean).length > 1) {
		fail('use only one of --target, --arch, --universal');
	}
	if (opts.universal && process.platform !== 'darwin') {
		fail('--universal needs macOS (lipo)');
	}
	return opts;
}

/** Rust triple -> { platform, arch } in Node naming. */
function describeTriple(triple) {
	for (const [key, value] of Object.entries(TRIPLES)) {
		if (value === triple) {
			const [platform, arch] = key.split('-');
			return { platform, arch };
		}
	}
	fail(`unsupported target triple: ${triple} (supported: ${Object.values(TRIPLES).join(', ')})`);
}

function run(cmd, args, options = {}) {
	return spawnSync(cmd, args, { encoding: 'utf8', ...options });
}

/** cargo + env to use, preferring the rustup toolchain over PATH. */
function resolveToolchain() {
	const rustup = run('rustup', ['which', 'cargo'], { cwd: crateDir });
	if (rustup.status === 0) {
		const cargo = rustup.stdout.trim();
		const rustc = run('rustup', ['which', 'rustc'], { cwd: crateDir }).stdout.trim();
		return { cargo, env: { ...process.env, RUSTC: rustc }, rustup: true };
	}
	const probe = run('cargo', ['--version']);
	if (probe.error || probe.status !== 0) {
		fail(
			'cargo was not found. Install Rust from https://rustup.rs (then reopen the shell) ' +
				'to build the Computer History helper.'
		);
	}
	return { cargo: 'cargo', env: process.env, rustup: false };
}

function ensureTarget(toolchain, triple) {
	if (!toolchain.rustup) return;
	const installed = run('rustup', ['target', 'list', '--installed'], { cwd: crateDir });
	if (installed.status === 0 && !installed.stdout.split(/\s+/).includes(triple)) {
		fail(`Rust target ${triple} is not installed. Run: rustup target add ${triple}`);
	}
}

function cargoBuild(toolchain, triple, debug) {
	ensureTarget(toolchain, triple);
	const args = ['build', '--locked', '--target', triple];
	if (!debug) args.push('--release');
	console.log(`Building ${BIN} for ${triple}${debug ? ' (debug)' : ''}...`);
	const result = spawnSync(toolchain.cargo, args, {
		cwd: crateDir,
		env: toolchain.env,
		stdio: 'inherit',
	});
	if (result.error) fail(`could not run cargo: ${result.error.message}`);
	if (result.status !== 0) fail(`cargo build failed for ${triple} (exit ${result.status})`);
	const exe = triple.includes('windows') ? `${BIN}.exe` : BIN;
	const built = path.join(crateDir, 'target', triple, debug ? 'debug' : 'release', exe);
	if (!fs.existsSync(built)) fail(`cargo reported success but ${built} is missing`);
	return built;
}

function install(src, platform, arch) {
	const dir = path.join(outRoot, `${platform}-${arch}`);
	fs.mkdirSync(dir, { recursive: true });
	const dest = path.join(dir, path.basename(src));
	fs.copyFileSync(src, dest);
	fs.chmodSync(dest, 0o755);
	console.log(`  -> ${path.relative(rootDir, dest)}`);
	return dest;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!fs.existsSync(path.join(crateDir, 'Cargo.toml'))) {
		fail(`crate not found at ${crateDir}`);
	}
	const toolchain = resolveToolchain();

	if (opts.universal) {
		const x64 = cargoBuild(toolchain, TRIPLES['darwin-x64'], opts.debug);
		const arm64 = cargoBuild(toolchain, TRIPLES['darwin-arm64'], opts.debug);
		const fatDir = path.join(crateDir, 'target', 'universal-apple-darwin');
		fs.mkdirSync(fatDir, { recursive: true });
		const fat = path.join(fatDir, BIN);
		const lipo = run('lipo', ['-create', '-output', fat, x64, arm64], { stdio: 'inherit' });
		if (lipo.error || lipo.status !== 0) fail('lipo failed to create the universal binary');
		for (const arch of ['universal', 'x64', 'arm64']) install(fat, 'darwin', arch);
		return;
	}

	let triple = opts.target;
	if (!triple) {
		const arch = opts.arch ?? process.arch;
		triple = TRIPLES[`${process.platform}-${arch}`];
		if (!triple) fail(`no Rust target for ${process.platform}-${arch}`);
	}
	const { platform, arch } = describeTriple(triple);
	install(cargoBuild(toolchain, triple, opts.debug), platform, arch);
}

main();
