/**
 * Installing `maestro-cli` on an SSH remote, so Federation can run a host there.
 *
 * Federation is opportunistic: a remote that runs a `maestro-cli host` gets its agents mirrored,
 * and any other SSH remote stays a plain SSH remote. This module turns the second kind into the
 * first. It copies THIS machine's CLI bundle (the same version, so there is no version skew) to
 * the remote over one SSH call, as the SSH user, into `~/.maestro`:
 *
 *   ~/.maestro/cli/maestro-cli.js     the bundle
 *   ~/.maestro/cli/prompts/core/      the prompts the host refuses to start without
 *   ~/.maestro/cli/scripts/           companions the CLI loads from beside itself (Pianola's runner)
 *   ~/.maestro/cli/node_modules/      better-sqlite3, built for the remote's Node and platform
 *   ~/.maestro/node/                  Node.js from nodejs.org, only when the remote has no Node 22+
 *   ~/.maestro/bin/maestro-cli        the launcher (on the PATH every SSH spawn gets)
 *
 * The bundle is plain JavaScript, so one bundle serves every platform. What differs per platform
 * is Node and the native SQLite module, and the remote script picks both for its own OS and CPU:
 * Linux, macOS, and Windows (a Windows remote answers SSH with Git Bash or WSL, the same POSIX
 * shell an SSH agent already needs there), each on x64 or arm64.
 *
 * Safety:
 * - Nothing runs as root and nothing outside `~/.maestro` is written.
 * - A `maestro-cli` already on the remote's PATH that Maestro did not install (Maestro.app, the
 *   server bundle) is left alone unless the caller forces it.
 * - The new install is staged beside the old one and swapped in only once it loads SQLite and
 *   prints its version, so a failed install leaves the old one working.
 * - A running host is never replaced under itself: the caller must ask for a restart, and the
 *   script then stops it with `host stop --wait` (which drains work in flight) before the swap.
 * - Node.js downloads are checked against nodejs.org's SHA-256 list.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import archiver from 'archiver';

import { redactSecrets } from '../../redactSecrets';
import { describeSshConnectionError } from '../../sshConnection';
import type { SshRemoteConfig } from '../../types';
import { resolveSshPath } from '../launch/ssh-path';
import { findBundledPromptsDir } from '../prompts/load';
import { SQLITE_PACKAGE } from '../store/native-sqlite';
import {
	RemoteDiscoveryError,
	buildRemoteScriptArgs,
	discoverRemoteHost,
	remoteVersionSkew,
	startRemoteHost,
	type RemoteHostDiscovery,
	type RemoteHostStartResult,
} from './remote-discovery';

/** The remote's install root, relative to the SSH user's home. */
export const REMOTE_INSTALL_ROOT = '.maestro';
/** The launcher Maestro installs, as the remote shell spells it. */
export const REMOTE_CLI_LAUNCHER = `$HOME/${REMOTE_INSTALL_ROOT}/bin/maestro-cli`;
/** The Node.js major line downloaded when the remote has no usable Node. */
export const REMOTE_NODE_MAJOR = 24;
/** The oldest Node.js the CLI runs on. */
export const REMOTE_MIN_NODE_MAJOR = 22;
/**
 * The `better-sqlite3` range installed next to the bundle. Kept equal to the `package.json`
 * dependency by a test, so the remote loads the API the bundle was built against.
 */
export const REMOTE_SQLITE_RANGE = '^12.11.1';
/** An install downloads Node and builds SQLite: far longer than a discovery call. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 10 * 60_000;

const MARKER = 'MAESTRO_INSTALL=';

/** This machine's CLI bundle, as the installer copies it. */
export interface LocalCliBundle {
	/** The `maestro-cli.js` file. */
	cliFile: string;
	/** The directory holding the bundled core prompts. */
	promptsDir: string;
	/** The bundle's version, compared with the remote's to skip a needless install. */
	version: string;
	/**
	 * Companion files the CLI loads from beside itself, by their path in the bundle. Today the
	 * Pianola sandbox runner (`scripts/pianola-sandbox/sandbox_runner.py`), which the app and the
	 * CLI build ship next to `maestro-cli.js`.
	 */
	companions?: Array<{ file: string; name: string }>;
}

/** Where a companion file sits in the bundle, and where a source checkout keeps it instead. */
const COMPANION_FILES = ['scripts/pianola-sandbox/sandbox_runner.py'] as const;

/** Each companion found beside `cliFile` (the app, the CLI build) or in the checkout above it. */
function findCompanions(cliFile: string): Array<{ file: string; name: string }> {
	const cliDir = path.dirname(cliFile);
	const found: Array<{ file: string; name: string }> = [];
	for (const name of COMPANION_FILES) {
		const file = [path.join(cliDir, name), path.resolve(cliDir, '..', '..', name)].find(
			(candidate) => fs.existsSync(candidate)
		);
		if (file) found.push({ file, name });
	}
	return found;
}

/**
 * Find the bundle's prompts beside `cliFile` the way the CLI itself looks for them, and describe
 * the bundle. Throws when the prompts are missing: a host installed without them refuses to start.
 */
export function resolveLocalCliBundle(cliFile: string, version: string): LocalCliBundle {
	// A source launch (ts-node, vitest) would copy a `.ts` module as the bundle.
	if (path.extname(cliFile) !== '.js') {
		throw new RemoteInstallError(
			'local-bundle',
			`${cliFile} is not a built maestro-cli bundle. Run the built CLI (npm run build:cli, then node dist/cli/maestro-cli.js).`
		);
	}
	if (!fs.existsSync(cliFile)) {
		throw new RemoteInstallError('local-bundle', `The maestro-cli bundle is missing: ${cliFile}`);
	}
	// The installed layout (`prompts/core` beside the bundle) first, then the CLI's own lookup
	// (the app's resources, a source checkout's `src/prompts`).
	const sibling = path.join(path.dirname(cliFile), 'prompts', 'core');
	const promptsDir = fs.existsSync(sibling)
		? sibling
		: findBundledPromptsDir(path.dirname(cliFile));
	if (!promptsDir) {
		throw new RemoteInstallError(
			'local-bundle',
			`The bundled prompts were not found beside ${cliFile}. Reinstall Maestro on this machine.`
		);
	}
	const companions = findCompanions(cliFile);
	return { cliFile, promptsDir, version, ...(companions.length ? { companions } : {}) };
}

/** Every file under `dir`, as POSIX paths relative to it. Symlinks are skipped. */
function listFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (current: string): void => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const abs = path.join(current, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile()) out.push(path.relative(dir, abs).split(path.sep).join('/'));
		}
	};
	walk(dir);
	return out.sort();
}

/**
 * The bundle as the gzip tar the remote script unpacks: `maestro-cli.js`, `prompts/core/`, and the
 * companion files at their bundle paths.
 */
export function packLocalCliBundle(bundle: LocalCliBundle): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const archive = archiver('tar', { gzip: true });
		const chunks: Buffer[] = [];
		archive.on('data', (chunk: Buffer) => chunks.push(chunk));
		archive.on('end', () => resolve(Buffer.concat(chunks)));
		archive.on('error', reject);
		archive.file(bundle.cliFile, { name: 'maestro-cli.js', mode: 0o755 });
		for (const rel of listFiles(bundle.promptsDir)) {
			archive.file(path.join(bundle.promptsDir, rel), { name: `prompts/core/${rel}` });
		}
		for (const companion of bundle.companions ?? []) {
			archive.file(companion.file, { name: companion.name });
		}
		void archive.finalize();
	});
}

/** Why an install did not finish. */
export type RemoteInstallErrorCode =
	| 'local-bundle'
	| 'broken-cli'
	| 'ssh-failed'
	| 'timeout'
	| 'host-running'
	| 'unsupported-os'
	| 'unsupported-arch'
	| 'foreign-cli'
	| 'upload'
	| 'unpack'
	| 'node-download'
	| 'node-unavailable'
	| 'node-checksum'
	| 'node-unpack'
	| 'no-checksum-tool'
	| 'no-npm'
	| 'sqlite-install'
	| 'sqlite-load'
	| 'cli-broken'
	| 'host-stop'
	| 'swap'
	| 'launcher'
	| 'malformed';

export class RemoteInstallError extends Error {
	readonly code: RemoteInstallErrorCode;
	constructor(code: RemoteInstallErrorCode, message: string) {
		super(message);
		this.name = 'RemoteInstallError';
		this.code = code;
	}
}

export interface RemoteInstallScriptOptions {
	/** Install even when a `maestro-cli` Maestro did not install is on the remote's PATH. */
	force?: boolean;
	/** Stop the host running from the current install (`host stop --wait`) before the swap. */
	restart?: boolean;
}

/**
 * The POSIX shell script that installs the bundle it reads from stdin. Prints `MAESTRO_INSTALL=`
 * marker lines (`platform=`, `node=`, `node-source=`, `cli-version=`, `done`, or `error=<code>`)
 * and exits 3 on a failure, with the failing tool's last lines on stderr.
 *
 * Stdin is read to the end FIRST, before any check can exit, so the local side never writes into
 * a closed pipe.
 */
export function buildRemoteInstallScript(options: RemoteInstallScriptOptions = {}): string {
	const npmCliProbe =
		"const p=require('path'),f=require('fs'),d=p.dirname(process.execPath);" +
		"const c=[p.join(d,'node_modules','npm','bin','npm-cli.js'),p.join(d,'..','lib','node_modules','npm','bin','npm-cli.js')];" +
		"c.find((x)=>f.existsSync(x))||''";
	const lines = [
		`FORCE=${options.force ? 1 : 0}`,
		`RESTART=${options.restart ? 1 : 0}`,
		`M='${MARKER}'`,
		`root="$HOME/${REMOTE_INSTALL_ROOT}"`,
		'cli="$root/cli"',
		'bin="$root/bin"',
		'stage="$root/cli.stage.$$"',
		'dl="$root/node.dl.$$"',
		`say() { printf '%s%s\\n' "$M" "$1"; }`,
		'fail() { say "error=$1"; rm -rf "$stage" "$dl" "$bin/maestro-cli.new"; exit 3; }',
		// Read the whole bundle before anything can exit.
		'mkdir -p "$stage" || { cat >/dev/null; fail upload; }',
		'cat > "$stage/bundle.tgz" || fail upload',
		'case "$(uname -s)" in Linux*) plat=linux;; Darwin*) plat=darwin;; MINGW*|MSYS*|CYGWIN*) plat=win;; *) say "os=$(uname -s)"; fail unsupported-os;; esac',
		'case "$(uname -m)" in x86_64|amd64) arch=x64;; aarch64|arm64) arch=arm64;; *) say "arch=$(uname -m)"; fail unsupported-arch;; esac',
		'say "platform=$plat-$arch"',
		'existing=$(command -v maestro-cli 2>/dev/null || true)',
		'if [ -n "$existing" ] && [ "$existing" != "$bin/maestro-cli" ] && [ "$FORCE" != 1 ]; then say "existing=$existing"; fail foreign-cli; fi',
		'(cd "$stage" && tar -xzf bundle.tgz && rm -f bundle.tgz) || fail unpack',
		'[ -f "$stage/maestro-cli.js" ] || fail unpack',
		// Node: the one on PATH when it is new enough, then a copy installed earlier, then nodejs.org.
		`nodeok() { _v=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) && [ -n "$_v" ] && [ "$_v" -ge ${REMOTE_MIN_NODE_MAJOR} ] 2>/dev/null; }`,
		'node=""; nodesrc=""',
		'if command -v node >/dev/null 2>&1 && nodeok "$(command -v node)"; then node=$(command -v node); nodesrc=system; fi',
		'nd="$root/node"',
		'if [ -z "$node" ]; then for c in "$nd/bin/node" "$nd/node.exe"; do if [ -f "$c" ] && nodeok "$c"; then node="$c"; nodesrc=cached; break; fi; done; fi',
		'if [ -z "$node" ]; then',
		'  mkdir -p "$dl" || fail node-download',
		'  fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 "$1" -o "$2"; elif command -v wget >/dev/null 2>&1; then wget -q -T 30 -O "$2" "$1"; else return 127; fi; }',
		`  base="https://nodejs.org/dist/latest-v${REMOTE_NODE_MAJOR}.x"`,
		'  fetch "$base/SHASUMS256.txt" "$dl/SHASUMS256.txt" || fail node-download',
		'  if [ "$plat" = win ]; then ext=zip; else ext=tar.gz; fi',
		'  file=$(grep -o "node-v[0-9.]*-$plat-$arch\\.$ext" "$dl/SHASUMS256.txt" | head -n 1)',
		'  [ -n "$file" ] || fail node-unavailable',
		'  fetch "$base/$file" "$dl/$file" || fail node-download',
		'  want=$(grep "  $file\\$" "$dl/SHASUMS256.txt" | cut -d " " -f 1)',
		'  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$dl/$file" | cut -d " " -f 1); elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$dl/$file" | cut -d " " -f 1); else fail no-checksum-tool; fi',
		'  { [ -n "$want" ] && [ "$want" = "$got" ]; } || fail node-checksum',
		'  if [ "$ext" = zip ]; then',
		'    if command -v unzip >/dev/null 2>&1; then (cd "$dl" && unzip -q "$file") || fail node-unpack;',
		`    else (cd "$dl" && powershell.exe -NoProfile -NonInteractive -Command "Expand-Archive -Path '$file' -DestinationPath '.'") || fail node-unpack; fi`,
		'  else (cd "$dl" && tar -xzf "$file") || fail node-unpack; fi',
		'  rm -rf "$nd" && mv "$dl/${file%.$ext}" "$nd" || fail node-unpack',
		'  rm -rf "$dl"',
		'  if [ "$plat" = win ]; then node="$nd/node.exe"; else node="$nd/bin/node"; fi',
		'  nodeok "$node" || fail node-unpack',
		'  nodesrc=downloaded',
		'fi',
		'say "node=$("$node" --version)"',
		'say "node-source=$nodesrc"',
		// SQLite, built (or fetched prebuilt) for this Node, this OS, and this CPU.
		`npmcli=$("$node" -p "${npmCliProbe}" 2>/dev/null)`,
		'if [ -n "$npmcli" ]; then runnpm() { "$node" "$npmcli" "$@"; }; elif command -v npm >/dev/null 2>&1; then runnpm() { npm "$@"; }; else fail no-npm; fi',
		`printf '%s\\n' '{"name":"maestro-remote-host","private":true}' > "$stage/package.json"`,
		`(cd "$stage" && PATH="$(dirname "$node"):$PATH" npm_config_cache="$root/npm-cache" runnpm install --omit=dev --no-audit --no-fund --loglevel=error "${SQLITE_PACKAGE}@${REMOTE_SQLITE_RANGE}") > "$stage/npm.log" 2>&1 || { tail -n 15 "$stage/npm.log" >&2; fail sqlite-install; }`,
		// The package name is an argument, not a literal in the code: this module ships in the CLI,
		// whose plain-Node import guard follows every `require()` it can see.
		`(cd "$stage" && "$node" -e "new (require(process.argv[1]))(':memory:').close()" ${SQLITE_PACKAGE}) 2> "$stage/sqlite.log" || { tail -n 5 "$stage/sqlite.log" >&2; fail sqlite-load; }`,
		'ver=$("$node" "$stage/maestro-cli.js" --version 2>/dev/null | head -n 1)',
		'[ -n "$ver" ] || fail cli-broken',
		// The launcher is written BEFORE anything is swapped, beside the live one, so a failed write
		// can never leave a truncated launcher in front of a deleted install. It finds Node when it
		// runs, not only where it was at install time: Maestro's own copy, then the install-time
		// Node, then whatever `node` is on PATH, so a Node a version manager later removes does not
		// strand the install.
		'mkdir -p "$bin" || fail launcher',
		'cat > "$bin/maestro-cli.new" <<MAESTRO_LAUNCHER || fail launcher',
		'#!/bin/sh',
		'for n in "\\$HOME/.maestro/node/bin/node" "\\$HOME/.maestro/node/node.exe" "$node"; do',
		'  [ -x "\\$n" ] && exec "\\$n" "$cli/maestro-cli.js" "\\$@"',
		'done',
		'n=\\$(command -v node) && exec "\\$n" "$cli/maestro-cli.js" "\\$@"',
		'echo "maestro-cli: no Node.js to run $cli/maestro-cli.js" >&2',
		'exit 127',
		'MAESTRO_LAUNCHER',
		'chmod 755 "$bin/maestro-cli.new" || fail launcher',
		// The running host may come from another install (a forced replacement): stop it with the CLI
		// that is on PATH now, else with Maestro's own launcher, else with the staged bundle.
		'if [ "$RESTART" = 1 ]; then',
		'  if [ -x "$bin/maestro-cli" ]; then stopper="$bin/maestro-cli"; elif [ -n "$existing" ]; then stopper="$existing"; else stopper=""; fi',
		'  if [ -n "$stopper" ]; then "$stopper" host stop --wait 120 >/dev/null 2>&1 || fail host-stop;',
		'  else "$node" "$stage/maestro-cli.js" host stop --wait 120 >/dev/null 2>&1 || fail host-stop; fi',
		// From here a failure leaves the host stopped: the caller says so with the fix.
		'  say host-stopped',
		'fi',
		// Swap: the old install stays as cli.old until the new install AND its launcher are in place,
		// and comes back if either step fails.
		'rollback() { rm -rf "$cli"; [ -d "$root/cli.old" ] && mv "$root/cli.old" "$cli"; }',
		'rm -rf "$root/cli.old"',
		'if [ -d "$cli" ]; then mv "$cli" "$root/cli.old" || fail swap; fi',
		'mv "$stage" "$cli" || { rollback; fail swap; }',
		'mv -f "$bin/maestro-cli.new" "$bin/maestro-cli" || { rollback; fail launcher; }',
		'rm -rf "$root/cli.old" "$cli/npm.log" "$cli/sqlite.log"',
		'say "cli-version=$ver"',
		'say done',
	];
	return lines.join('\n');
}

/** What the install script reported. */
export interface RemoteInstallReport {
	/** `<os>-<arch>` as nodejs.org names it, e.g. `linux-x64`, `darwin-arm64`, `win-x64`. */
	platform: string;
	/** The Node.js version the host runs on, e.g. `v24.11.0`. */
	nodeVersion: string;
	/** `system`: the remote's own Node; `cached`: one installed earlier; `downloaded`: from nodejs.org. */
	nodeSource: 'system' | 'cached' | 'downloaded';
	/** What the installed CLI prints for `--version`. */
	cliVersion: string;
}

/** The `key=value` marker lines in the script's stdout. */
export function readInstallMarkers(stdout: string): Map<string, string> {
	const markers = new Map<string, string>();
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.startsWith(MARKER)) continue;
		const body = line.slice(MARKER.length).trim();
		const at = body.indexOf('=');
		if (at === -1) markers.set(body, '');
		else markers.set(body.slice(0, at), body.slice(at + 1));
	}
	return markers;
}

function safeText(text: string): string {
	return redactSecrets(text, { hexBlobs: true }).text.trim();
}

/** The last few lines of remote stderr, redacted, as the tail of an error message. */
function stderrTail(stderr: string): string {
	const tail = safeText(stderr).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
	return tail ? ` Remote said: ${tail}` : '';
}

/** The message for a failure the script reported. */
export function installErrorMessage(
	code: RemoteInstallErrorCode,
	label: string,
	markers: Map<string, string>,
	stderr: string
): string {
	const tail = stderrTail(stderr);
	switch (code) {
		case 'unsupported-os':
			return `Maestro cannot install a host on ${label} (${markers.get('os') ?? 'unknown OS'}). Hosts run on Linux, macOS, and Windows through Git Bash or WSL.`;
		case 'unsupported-arch':
			return `Maestro cannot install a host on ${label}: Node.js has no build for its CPU (${markers.get('arch') ?? 'unknown'}). Hosts run on x64 and arm64.`;
		case 'foreign-cli':
			return (
				`${label} already has a maestro-cli Maestro did not install (${markers.get('existing') ?? 'on PATH'}). ` +
				"Upgrade that install, or install again with --force to put Maestro's own copy in ~/.maestro, which then takes precedence."
			);
		case 'node-download':
			return `Could not download Node.js from nodejs.org on ${label}. The remote needs to reach nodejs.org, or have Node.js ${REMOTE_MIN_NODE_MAJOR} or newer installed.${tail}`;
		case 'node-unavailable':
			return `nodejs.org has no Node.js ${REMOTE_NODE_MAJOR} build for ${markers.get('platform') ?? label}. Install Node.js ${REMOTE_MIN_NODE_MAJOR} or newer on the remote, then try again.`;
		case 'node-checksum':
			return `The Node.js download on ${label} did not match the checksum nodejs.org publishes, so it was thrown away. Try again.`;
		case 'no-checksum-tool':
			return `${label} has neither sha256sum nor shasum, so a Node.js download cannot be verified. Install Node.js ${REMOTE_MIN_NODE_MAJOR} or newer on the remote, then try again.`;
		case 'node-unpack':
			return `Could not unpack Node.js on ${label}.${tail}`;
		case 'no-npm':
			return `${label} has Node.js but no npm to install the SQLite module with. Install npm on the remote, then try again.`;
		case 'sqlite-install':
			return (
				`npm could not install better-sqlite3 on ${label}. It needs to reach the npm registry, and a compiler ` +
				`toolchain (python3, make, a C++ compiler) where no prebuilt binary exists for this platform.${tail}`
			);
		case 'sqlite-load':
			return `better-sqlite3 installed on ${label} but does not load under its Node.js.${tail}`;
		case 'cli-broken':
			return `The copied maestro-cli does not run on ${label}.${tail}`;
		case 'host-stop':
			return `The host on ${label} did not stop within 120 seconds, so the install was not swapped in. Nothing changed.`;
		case 'upload':
		case 'unpack':
			return `Could not copy the maestro-cli bundle to ${label}.${tail}`;
		case 'swap':
		case 'launcher':
			return `Could not put the new maestro-cli in place under ~/.maestro on ${label}.${tail}`;
		default:
			return `The install on ${label} failed (${code}).${tail}`;
	}
}

const SCRIPT_ERROR_CODES: ReadonlySet<string> = new Set<RemoteInstallErrorCode>([
	'unsupported-os',
	'unsupported-arch',
	'foreign-cli',
	'upload',
	'unpack',
	'node-download',
	'node-unavailable',
	'node-checksum',
	'node-unpack',
	'no-checksum-tool',
	'no-npm',
	'sqlite-install',
	'sqlite-load',
	'cli-broken',
	'host-stop',
	'swap',
	'launcher',
]);

export interface BinaryExecResult {
	stdout: string;
	stderr: string;
	/** The exit code, `'ETIMEDOUT'` on a timeout, or the spawn error code. */
	exitCode: number | string;
}

/** Runs one process with `input` on stdin. Injected by tests. */
export type RemoteBinaryExec = (
	command: string,
	args: string[],
	options: { timeout: number; input: Buffer }
) => Promise<BinaryExecResult>;

/** The default `RemoteBinaryExec`: spawn, write the bytes, collect the output, kill on timeout. */
export const spawnWithInput: RemoteBinaryExec = (command, args, { timeout, input }) =>
	new Promise((resolve) => {
		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (exitCode: number | string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode });
		};
		const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			finish('ETIMEDOUT');
		}, timeout);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => (stdout += chunk));
		child.stderr.on('data', (chunk: string) => (stderr += chunk));
		child.on('error', (error: NodeJS.ErrnoException) => finish(error.code ?? 'ENOENT'));
		child.on('close', (code) => finish(code ?? 1));
		// The remote reads stdin to the end first; a pipe that still breaks (ssh died) is reported
		// through the exit code, not as an unhandled error.
		child.stdin.on('error', () => {});
		child.stdin.end(input);
	});

export interface InstallRemoteCliOptions extends RemoteInstallScriptOptions {
	/** Ceiling for the whole install. Default ten minutes. */
	timeoutMs?: number;
	/** The `ssh` binary. Default `resolveSshPath()`. */
	sshPath?: string;
	exec?: RemoteBinaryExec;
}

function remoteLabel(remote: SshRemoteConfig): string {
	return remote.name || remote.host;
}

/**
 * Copy `bundle` to `remote` and install it there over ONE ssh call. Resolves to what the script
 * reported, or rejects with a `RemoteInstallError` whose message names the fix and holds no secret.
 */
export async function installRemoteCli(
	remote: SshRemoteConfig,
	bundle: LocalCliBundle,
	options: InstallRemoteCliOptions = {}
): Promise<RemoteInstallReport> {
	const timeout = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
	const exec = options.exec ?? spawnWithInput;
	const sshPath = options.sshPath ?? (await resolveSshPath());
	const label = remoteLabel(remote);
	const archive = await packLocalCliBundle(bundle);
	const script = buildRemoteInstallScript(options);
	const result = await exec(sshPath, buildRemoteScriptArgs(remote, script), {
		timeout,
		input: archive,
	});

	if (result.exitCode === 'ETIMEDOUT') {
		throw new RemoteInstallError(
			'timeout',
			`The install on ${label} did not finish within ${Math.round(timeout / 60_000)} minutes. A slow download may still be running there; try again later.`
		);
	}
	const markers = readInstallMarkers(result.stdout);
	const failed = markers.get('error');
	if (failed !== undefined) {
		const code = (SCRIPT_ERROR_CODES.has(failed) ? failed : 'malformed') as RemoteInstallErrorCode;
		const stopped = markers.has('host-stopped')
			? ` The host on ${label} was stopped for the upgrade and is not running now: once the cause is fixed, install again, or start the old one with maestro-cli remote-host start ${remote.id}.`
			: '';
		throw new RemoteInstallError(
			code,
			installErrorMessage(code, label, markers, result.stderr) + stopped
		);
	}
	if (!markers.has('platform')) {
		const detail = describeSshConnectionError(safeText(result.stderr));
		throw new RemoteInstallError(
			'ssh-failed',
			`Could not run the installer on ${label}${detail ? `: ${detail}` : '.'}`
		);
	}
	const nodeSource = markers.get('node-source');
	const cliVersion = markers.get('cli-version');
	if (!markers.has('done') || !cliVersion) {
		throw new RemoteInstallError(
			'malformed',
			`The install on ${label} stopped before it finished (exit ${String(result.exitCode)}).${stderrTail(result.stderr)}`
		);
	}
	return {
		platform: markers.get('platform') ?? '',
		nodeVersion: markers.get('node') ?? '',
		nodeSource:
			nodeSource === 'system' || nodeSource === 'cached' || nodeSource === 'downloaded'
				? nodeSource
				: 'system',
		cliVersion,
	};
}

/** What `setupRemoteHost()` did to the CLI. */
export type RemoteCliAction =
	/** Installed where there was none. */
	| 'installed'
	/** Replaced an older install with this machine's version. */
	| 'upgraded'
	/** The remote already runs this version (or `--force` was not needed). */
	| 'current'
	/** The remote runs a NEWER version: never downgraded. */
	| 'newer';

export interface RemoteHostSetupResult {
	cli: RemoteCliAction;
	/** The remote's CLI version after setup, when known. */
	cliVersion?: string;
	/** Set when this call ran the installer. */
	install?: RemoteInstallReport;
	/** Set when `start` was asked for. */
	start?: RemoteHostStartResult;
	/** The `loginctl enable-linger <user>` line to run on a Linux remote, when lingering is off. */
	lingerFix?: string;
}

export interface SetupRemoteHostOptions extends InstallRemoteCliOptions {
	/** Start the host once the CLI is in place. */
	start?: boolean;
	/** Timeout for the discovery and start calls. Default 60 s. */
	discoveryTimeoutMs?: number;
	/** Test seams. */
	discover?: typeof discoverRemoteHost;
	startHost?: typeof startRemoteHost;
	install?: typeof installRemoteCli;
}

/**
 * Make `remote` able to run a Federation host: install this machine's CLI when the remote has
 * none, upgrade it when the remote's is older, and (with `start`) start the host. The one path
 * behind `maestro-cli remote-host install` and the desktop's Make Federated, so both do exactly
 * the same thing.
 *
 * A running host on an older version is only replaced with `restart`; without it the call refuses
 * with `host-running`, because the swap would pull the install out from under it.
 */
export async function setupRemoteHost(
	remote: SshRemoteConfig,
	bundle: LocalCliBundle,
	options: SetupRemoteHostOptions = {}
): Promise<RemoteHostSetupResult> {
	const discover = options.discover ?? discoverRemoteHost;
	const startHost = options.startHost ?? startRemoteHost;
	const install = options.install ?? installRemoteCli;
	const discoveryOptions = {
		...(options.discoveryTimeoutMs !== undefined ? { timeoutMs: options.discoveryTimeoutMs } : {}),
		...(options.sshPath !== undefined ? { sshPath: options.sshPath } : {}),
	};
	const label = remoteLabel(remote);

	let found: RemoteHostDiscovery | 'too-old';
	try {
		found = await discover(remote, discoveryOptions);
	} catch (error) {
		// A CLI too old to know `host endpoint`, or one that no longer runs (its launcher answers
		// with something that is not a report, such as a Node that was removed), is an install to
		// replace, not a failure. The script still refuses to replace a CLI Maestro did not install.
		// A broken one is only replaced with `force`: a host may still run from it, and only the
		// person can say the install is safe to replace.
		if (
			error instanceof RemoteDiscoveryError &&
			(error.code === 'unsupported' || (error.code === 'malformed' && options.force))
		) {
			found = 'too-old';
		} else if (error instanceof RemoteDiscoveryError && error.code === 'malformed') {
			throw new RemoteInstallError(
				'broken-cli',
				`${error.message} The maestro-cli there may be broken. Install again with --force to replace Maestro's copy.`
			);
		} else throw error;
	}

	let cli: RemoteCliAction;
	let cliVersion: string | undefined;
	let report: RemoteInstallReport | undefined;
	const running = found !== 'too-old' && found.installed && found.running;
	const foundVersion = found !== 'too-old' && found.installed ? found.cliVersion : undefined;
	const skew =
		found !== 'too-old' && found.installed
			? remoteVersionSkew(bundle.version, found.cliVersion)
			: 'unknown';

	if (found !== 'too-old' && found.installed && !options.force && skew === 'none') {
		cli = 'current';
		cliVersion = found.cliVersion;
	} else if (found !== 'too-old' && found.installed && !options.force && skew === 'remote-newer') {
		cli = 'newer';
		cliVersion = found.cliVersion;
	} else {
		if (running && !options.restart) {
			throw new RemoteInstallError(
				'host-running',
				`A host is running on ${label} on version ${foundVersion ?? 'unknown'}. Installing ${bundle.version} replaces it: ` +
					'install again with --restart to stop it (waiting for work in flight), upgrade, and start it again.'
			);
		}
		report = await install(remote, bundle, { ...options, restart: running });
		cli = found !== 'too-old' && !found.installed ? 'installed' : 'upgraded';
		cliVersion = report.cliVersion;
	}

	const result: RemoteHostSetupResult = {
		cli,
		...(cliVersion ? { cliVersion } : {}),
		...(report ? { install: report } : {}),
	};
	// Start when asked, and restart a host the upgrade stopped.
	if (options.start || (running && report)) {
		result.start = await startHost(remote, discoveryOptions);
	}
	// The warning comes from discovery when a CLI was there, else from the start that followed a
	// first install (discovery of a remote with no CLI cannot report it).
	const lingerFix =
		(found !== 'too-old' && found.installed ? found.lingerFix : undefined) ??
		(result.start?.installed && result.start.started ? result.start.lingerFix : undefined);
	if (lingerFix) result.lingerFix = lingerFix;
	return result;
}
