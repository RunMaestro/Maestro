#!/usr/bin/env node
/**
 * Assemble the Cue server bundle: everything a Linux host or container needs
 * to run `maestro-cli cue engine` without the desktop app.
 *
 *   dist/server/maestro-server/
 *     maestro-cli.js         the CLI bundle (built by build-cli.mjs)
 *     bin/maestro-cli        wrapper that pins the server's data directory
 *     prompts/               the prompt files the CLI loads at run time
 *     package.json           pins better-sqlite3, the one native dependency
 *     maestro-cue.service    systemd unit
 *     install.sh             installer for a Debian or Ubuntu host
 *   dist/maestro-server-<version>.tgz
 *
 * `better-sqlite3` is not installed here. The desktop's copy is rebuilt for
 * Electron's ABI and cannot load under plain Node, so the bundle carries only
 * the pinned version and `npm install` on the target (or in the image) fetches
 * the build for that Node and that architecture.
 *
 * `maestro-p.js` is left out: it serves Claude's TUI mode, which also needs
 * node-pty and a workspace Claude Code has trusted. Server agents run in API
 * mode, and the CLI treats a missing `maestro-p.js` as TUI mode unavailable.
 *
 * Run through `npm run build:server`, which builds the CLI first.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const serverRoot = path.join(rootDir, 'dist/server');
const bundleDir = path.join(serverRoot, 'maestro-server');
const packagingDir = path.join(rootDir, 'packaging/server');

const pkgJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(rootDir, 'package-lock.json'), 'utf8'));
const version = pkgJson.version;
const sqliteVersion = lock.packages?.['node_modules/better-sqlite3']?.version;
if (!sqliteVersion) {
	throw new Error('package-lock.json has no better-sqlite3 entry to pin');
}

const cliBundle = path.join(rootDir, 'dist/cli/maestro-cli.js');
if (!fs.existsSync(cliBundle)) {
	throw new Error(`${cliBundle} is missing. Run "npm run build:server", which builds it first.`);
}

/** Copy every `*.md` directly in `from` (not its subfolders) into `to`. */
function copyMarkdown(from, to) {
	fs.mkdirSync(to, { recursive: true });
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.endsWith('.md')) {
			fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
		}
	}
}

fs.rmSync(serverRoot, { recursive: true, force: true });
fs.mkdirSync(bundleDir, { recursive: true });

fs.copyFileSync(cliBundle, path.join(bundleDir, 'maestro-cli.js'));
fs.chmodSync(path.join(bundleDir, 'maestro-cli.js'), 0o755);

// Same layout the desktop ships as extraResources (package.json "build"), so
// the CLI's prompt loader finds them beside the bundle.
const promptsSrc = path.join(rootDir, 'src/prompts');
copyMarkdown(promptsSrc, path.join(bundleDir, 'prompts/core'));
for (const folder of ['speckit', 'openspec', 'bmad']) {
	fs.cpSync(path.join(promptsSrc, folder), path.join(bundleDir, 'prompts', folder), {
		recursive: true,
	});
}

const serverPackage = {
	name: 'maestro-server',
	version,
	private: true,
	description: 'Maestro CLI and Cue engine for a server or container',
	license: pkgJson.license,
	bin: { 'maestro-cli': './maestro-cli.js' },
	engines: pkgJson.engines,
	dependencies: { 'better-sqlite3': sqliteVersion },
	// Its install script fetches or compiles the native binary. npm warns about
	// unlisted install scripts and is moving to skipping them.
	allowScripts: { 'better-sqlite3': true },
};
fs.writeFileSync(
	path.join(bundleDir, 'package.json'),
	`${JSON.stringify(serverPackage, null, '\t')}\n`
);

fs.copyFileSync(
	path.join(packagingDir, 'maestro-cue.service'),
	path.join(bundleDir, 'maestro-cue.service')
);
fs.copyFileSync(path.join(packagingDir, 'install.sh'), path.join(bundleDir, 'install.sh'));
fs.chmodSync(path.join(bundleDir, 'install.sh'), 0o755);
fs.mkdirSync(path.join(bundleDir, 'bin'));
fs.copyFileSync(path.join(packagingDir, 'maestro-cli'), path.join(bundleDir, 'bin/maestro-cli'));
fs.chmodSync(path.join(bundleDir, 'bin/maestro-cli'), 0o755);

const tarball = path.join(rootDir, 'dist', `maestro-server-${version}.tgz`);
// macOS tar otherwise adds AppleDouble files and xattr headers that GNU tar
// on the target warns about.
const macTarArgs = process.platform === 'darwin' ? ['--no-mac-metadata'] : [];
execFileSync('tar', [...macTarArgs, '-czf', tarball, '-C', serverRoot, 'maestro-server'], {
	stdio: 'inherit',
	env: { ...process.env, COPYFILE_DISABLE: '1' },
});

const sizeKB = (fs.statSync(tarball).size / 1024).toFixed(1);
console.log(`✓ Built ${bundleDir}`);
console.log(`✓ Built ${tarball} (${sizeKB} KB, better-sqlite3 ${sqliteVersion})`);
