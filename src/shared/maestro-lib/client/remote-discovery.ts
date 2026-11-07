/**
 * Finding the `maestro-cli host` on an SSH remote (Federation, pairing P1 of #1716).
 *
 * The laptop asks the remote for its host's endpoint over ONE `ssh` invocation, on every connect,
 * and keeps the answer in memory only (decision D1): SSH already authenticated the user, so the
 * port, path token and CLI secret the remote prints are all the credential this path needs. The
 * remote side is `maestro-cli host endpoint --json`.
 *
 * One invocation, never several: some remotes reach their host through a tailcat `ProxyCommand`
 * with a ControlMaster, and those fail under concurrent dials. So the script below finds the CLI,
 * reads its version and asks for the endpoint in the same remote shell.
 *
 * The connection arguments come from `buildSshConnectionArgs()`, the builder `test-ssh-remote` and
 * the desktop probe use, and the remote command runs under `wrapRemoteCommandWithPath()`, the PATH
 * an agent spawn gets, because a non-interactive SSH shell's PATH rarely holds `~/.local/bin` or a
 * Node version manager.
 *
 * Secrets: the endpoint's token and secret travel only in the returned value. Every error message
 * is built from fixed text plus ssh's stderr passed through `redactSecrets()`; the remote's stdout,
 * which is where a token would be, never reaches a message.
 */

import { buildSshConnectionArgs, describeSshConnectionError } from '../../sshConnection';
import type { HostEndpoint } from './discovery';
import { compareVersions } from '../../pathUtils';
import { redactSecrets } from '../../redactSecrets';
import type { SshRemoteConfig } from '../../types';
import { execFileNoThrow, type ExecResult } from '../launch/exec-file';
import { shellEscape } from '../launch/shell-escape';
import { wrapRemoteCommandWithPath } from '../launch/ssh-command-builder';
import { resolveSshPath } from '../launch/ssh-path';

/** Where Maestro.app keeps the CLI bundle on a Mac remote with no `maestro-cli` on PATH. */
export const MAC_APP_CLI_PATH = '/Applications/Maestro.app/Contents/Resources/maestro-cli.js';

/** How the remote ran `maestro-cli`: the command on PATH, or `node` on the Maestro.app bundle. */
export type RemoteCliLauncher = 'path' | 'app-bundle';

/**
 * Set when the remote said lingering is off for the SSH user (Linux, `loginctl ... Linger=no`), so
 * systemd-logind may stop its host when the SSH session that started it ends. `lingerFix` is the
 * command that turns it on, for the operator to run; nothing here runs it.
 */
export interface RemoteLingerWarning {
	linger?: false;
	lingerFix?: string;
}

/** What discovery found on the remote. */
export type RemoteHostDiscovery =
	/** No usable `maestro-cli` on the remote. `fix` names what to install (decision D3). */
	| { installed: false; fix: string }
	/** The CLI is there, but no host serves its data directory. */
	| ({
			installed: true;
			running: false;
			launcher: RemoteCliLauncher;
			cliVersion?: string;
	  } & RemoteLingerWarning)
	| ({
			installed: true;
			running: true;
			launcher: RemoteCliLauncher;
			cliVersion?: string;
			endpoint: HostEndpoint;
	  } & RemoteLingerWarning);

/** Why discovery could not give an answer. The message never holds a token or a secret. */
export type RemoteDiscoveryErrorCode =
	/** ssh could not reach the remote, or the remote shell did not run the script. */
	| 'ssh-failed'
	/** No answer within the timeout. */
	| 'timeout'
	/** The remote CLI refused (for example a discovery file other users can read). */
	| 'refused'
	/** The remote CLI predates `host endpoint`. */
	| 'unsupported'
	/** The remote printed something that is not a host endpoint. */
	| 'malformed';

export class RemoteDiscoveryError extends Error {
	readonly code: RemoteDiscoveryErrorCode;
	constructor(code: RemoteDiscoveryErrorCode, message: string) {
		super(message);
		this.name = 'RemoteDiscoveryError';
		this.code = code;
	}
}

/** Runs one process to completion. Injected by tests; the default is `execFileNoThrow`. */
export type RemoteExec = (
	command: string,
	args: string[],
	options: { timeout: number }
) => Promise<ExecResult>;

export interface DiscoverRemoteHostOptions {
	/** Ceiling for the whole SSH round trip, beyond ssh's own `ConnectTimeout`. Default 60 s. */
	timeoutMs?: number;
	/** The `ssh` binary. Default `resolveSshPath()`. */
	sshPath?: string;
	exec?: RemoteExec;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Lines the script prints before the CLI's own output, so the parser can tell "the remote ran our
 * script" from a banner or a `ProxyCommand` that answered with something else.
 */
const LAUNCHER_MARKER = 'MAESTRO_REMOTE_CLI=';
const VERSION_MARKER = 'MAESTRO_REMOTE_CLI_VERSION=';
const NOT_FOUND = 'none';
const NO_NODE = 'no-node';

const INSTALL_FIX =
	'Install Maestro on the remote: Maestro.app on a Mac, or the server bundle on Linux ' +
	'(docs/maestro-cue-server.md), so `maestro-cli` is on its PATH.';
const NO_NODE_FIX =
	`The remote has ${MAC_APP_CLI_PATH} but no \`node\` on its PATH to run it. ` +
	'Install Node.js on the remote, or put `maestro-cli` on its PATH.';

/**
 * A POSIX shell script that finds the remote's `maestro-cli` (PATH first, then the Maestro.app
 * bundle under `node`), prints which one and its version, then runs each invocation in turn with
 * it. Exits 127 with a `none` / `no-node` marker when there is no usable CLI. Exported so the
 * `remote-host` verbs run their own CLI calls through the same lookup.
 */
export function buildRemoteMaestroCliScript(...invocations: string[][]): string {
	const app = shellEscape(MAC_APP_CLI_PATH);
	const lookup =
		'if command -v maestro-cli >/dev/null 2>&1; then _via=path; _mc() { maestro-cli "$@"; }; ' +
		`elif [ -f ${app} ]; then ` +
		`if command -v node >/dev/null 2>&1; then _via=app-bundle; _mc() { node ${app} "$@"; }; ` +
		`else echo "${LAUNCHER_MARKER}${NO_NODE}"; exit 127; fi; ` +
		`else echo "${LAUNCHER_MARKER}${NOT_FOUND}"; exit 127; fi`;
	const announce = `echo "${LAUNCHER_MARKER}$_via"; echo "${VERSION_MARKER}$(_mc --version 2>/dev/null | head -n 1)"`;
	const runs = invocations.map((args) => `_mc ${args.map(shellEscape).join(' ')}`);
	return [lookup, announce, ...runs].join('; ');
}

/** The `ssh` argv that runs `script` on `remote`, everything after the binary. */
export function buildRemoteScriptArgs(remote: SshRemoteConfig, script: string): string[] {
	return [...buildSshConnectionArgs(remote), wrapRemoteCommandWithPath(script)];
}

/** Remote text (ssh stderr, a CLI refusal), made safe for an error message. */
function safeText(text: string): string {
	return redactSecrets(text, { hexBlobs: true }).text.trim();
}

/** The marker block the script printed, and whatever followed it. */
interface ScriptOutput {
	launcher: string;
	cliVersion?: string;
	/** Everything the CLI printed after the markers. */
	body: string;
}

/**
 * Find the marker lines in the remote's stdout. Returns null when the script never announced a
 * launcher, which means the remote did not run it.
 */
export function readRemoteScriptOutput(stdout: string): ScriptOutput | null {
	const lines = stdout.split(/\r?\n/);
	const at = lines.findIndex((line) => line.startsWith(LAUNCHER_MARKER));
	if (at === -1) return null;
	const launcher = lines[at].slice(LAUNCHER_MARKER.length).trim();
	let rest = lines.slice(at + 1);
	let cliVersion: string | undefined;
	if (rest[0]?.startsWith(VERSION_MARKER)) {
		cliVersion = rest[0].slice(VERSION_MARKER.length).trim() || undefined;
		rest = rest.slice(1);
	}
	return { launcher, cliVersion, body: rest.join('\n').trim() };
}

function isPort(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 65536;
}

function optionalString(value: unknown): value is string | undefined {
	return value === undefined || typeof value === 'string';
}

/**
 * Validate a `host endpoint --json` payload. Returns the endpoint, `'not-running'`, the CLI's own
 * `{error}` text, or null for anything else. Never echoes the payload, which may hold the token.
 */
export function parseHostEndpointReport(
	raw: string
): HostEndpoint | 'not-running' | { error: string } | null {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const record = data as Record<string, unknown>;
	if (typeof record.error === 'string') return { error: record.error };
	if (record.running === false) return 'not-running';
	if (record.running !== true) return null;
	const { port, token, cliSecret, version, pid } = record;
	if (!isPort(port) || typeof token !== 'string' || !token || typeof pid !== 'number') return null;
	if (!optionalString(cliSecret) || !optionalString(version)) return null;
	return {
		port,
		token,
		...(cliSecret !== undefined ? { cliSecret } : {}),
		...(version !== undefined ? { version } : {}),
		pid,
	};
}

/**
 * The linger warning in a `host endpoint --json` payload, or `{}`. A fix that is not one plain
 * `loginctl enable-linger <user>` line is dropped: it is printed on the laptop as a command to run.
 */
export function readRemoteLingerWarning(raw: string): RemoteLingerWarning {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return {};
	}
	if (!data || typeof data !== 'object') return {};
	const { linger, lingerFix } = data as Record<string, unknown>;
	if (linger !== false) return {};
	return typeof lingerFix === 'string' && /^loginctl enable-linger [\w.@-]+$/.test(lingerFix)
		? { linger: false, lingerFix }
		: { linger: false };
}

function remoteLabel(remote: SshRemoteConfig): string {
	return remote.name || remote.host;
}

/** What one run of the remote CLI script produced, once a usable CLI was found. */
interface RemoteCliRun {
	launcher: RemoteCliLauncher;
	cliVersion?: string;
	/** Everything the CLI printed after the markers. Can hold a token: never put it in a message. */
	body: string;
	exitCode: ExecResult['exitCode'];
	stderr: string;
	label: string;
}

type RemoteCliOutcome = { installed: false; fix: string } | ({ installed: true } & RemoteCliRun);

function execOf(options: DiscoverRemoteHostOptions): RemoteExec {
	return options.exec ?? ((command, args, opts) => execFileNoThrow(command, args, undefined, opts));
}

/**
 * Run one `maestro-cli` invocation on `remote` over ONE ssh call, through the PATH-then-app-bundle
 * lookup. Resolves to "not installed" with the fix, or to what the CLI printed; rejects with a
 * `RemoteDiscoveryError` when ssh failed, timed out, or the remote did not run the script.
 */
async function runRemoteMaestroCli(
	remote: SshRemoteConfig,
	args: string[],
	options: DiscoverRemoteHostOptions
): Promise<RemoteCliOutcome> {
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const exec = execOf(options);
	const sshPath = options.sshPath ?? (await resolveSshPath());
	const script = buildRemoteMaestroCliScript(args);
	const result = await exec(sshPath, buildRemoteScriptArgs(remote, script), { timeout });
	const label = remoteLabel(remote);

	if (result.exitCode === 'ETIMEDOUT') {
		throw new RemoteDiscoveryError(
			'timeout',
			`No answer from ${label} within ${Math.round(timeout / 1000)}s. The host or its ProxyCommand accepted the connection but never replied.`
		);
	}

	const output = readRemoteScriptOutput(result.stdout);
	if (!output) {
		const detail = describeSshConnectionError(safeText(result.stderr));
		throw new RemoteDiscoveryError(
			'ssh-failed',
			`Could not run maestro-cli on ${label}${detail ? `: ${detail}` : '.'}`
		);
	}

	if (output.launcher === NOT_FOUND) return { installed: false, fix: INSTALL_FIX };
	if (output.launcher === NO_NODE) return { installed: false, fix: NO_NODE_FIX };
	if (output.launcher !== 'path' && output.launcher !== 'app-bundle') {
		throw new RemoteDiscoveryError(
			'malformed',
			`${label} answered with an unknown maestro-cli launcher.`
		);
	}
	return {
		installed: true,
		launcher: output.launcher,
		...(output.cliVersion ? { cliVersion: output.cliVersion } : {}),
		body: output.body,
		exitCode: result.exitCode,
		stderr: result.stderr,
		label,
	};
}

/** The remote CLI exists but does not know the verb it was asked for. */
function unsupportedVerb(run: RemoteCliRun, verb: string): RemoteDiscoveryError | null {
	if (run.body || !/unknown command|too many arguments/i.test(run.stderr)) return null;
	return new RemoteDiscoveryError(
		'unsupported',
		`maestro-cli on ${run.label}${run.cliVersion ? ` (${run.cliVersion})` : ''} has no \`${verb}\` verb. Upgrade Maestro on the remote.`
	);
}

/**
 * Ask `remote` for its host's endpoint over one SSH invocation. Resolves to a typed answer, or
 * rejects with a `RemoteDiscoveryError` whose message names the fix and holds no secret.
 *
 * The caller decides whether the remote may be probed at all: Federation only dials a remote whose
 * own `federation` flag is on (decision D8).
 */
export async function discoverRemoteHost(
	remote: SshRemoteConfig,
	options: DiscoverRemoteHostOptions = {}
): Promise<RemoteHostDiscovery> {
	const run = await runRemoteMaestroCli(remote, ['host', 'endpoint', '--json'], options);
	if (!run.installed) return run;
	const { launcher, cliVersion, label } = run;

	const report = parseHostEndpointReport(run.body);
	const linger = readRemoteLingerWarning(run.body);
	if (report === 'not-running') {
		return {
			installed: true,
			running: false,
			launcher,
			...(cliVersion ? { cliVersion } : {}),
			...linger,
		};
	}
	if (report && 'error' in report) {
		throw new RemoteDiscoveryError(
			'refused',
			`maestro-cli on ${label} refused: ${safeText(report.error)}`
		);
	}
	if (report) {
		return {
			installed: true,
			running: true,
			launcher,
			...(cliVersion ? { cliVersion } : {}),
			endpoint: report,
			...linger,
		};
	}

	const unsupported = unsupportedVerb(run, 'host endpoint');
	if (unsupported) throw unsupported;
	throw new RemoteDiscoveryError(
		'malformed',
		`maestro-cli on ${label} returned output that is not a host endpoint (exit ${String(run.exitCode)}).`
	);
}

/** What `maestro-cli host start --json` did on the remote. */
export type RemoteHostStartResult =
	/** No usable `maestro-cli` on the remote. */
	| { installed: false; fix: string }
	/** A host was started (`alreadyRunning: false`) or was already serving (`true`). */
	| { installed: true; started: true; alreadyRunning: boolean; pid: number; port: number }
	/** The remote's desktop app is the host there, so no headless host can start. */
	| { installed: true; started: false; reason: 'desktop-running'; pid: number };

/**
 * Run `maestro-cli host start --json` on `remote` over one SSH invocation (decision D2: the host
 * runs as the SSH user). Rejects with a `RemoteDiscoveryError` when the remote CLI failed to start
 * one; the message carries the CLI's own reason, redacted. Like discovery, the caller checks the
 * remote's `federation` flag first.
 */
export async function startRemoteHost(
	remote: SshRemoteConfig,
	options: DiscoverRemoteHostOptions = {}
): Promise<RemoteHostStartResult> {
	const run = await runRemoteMaestroCli(remote, ['host', 'start', '--json'], options);
	if (!run.installed) return run;
	const { label } = run;

	let data: Record<string, unknown> | null = null;
	try {
		const parsed: unknown = JSON.parse(run.body);
		if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>;
	} catch {
		data = null;
	}
	if (data) {
		const { started, alreadyRunning, reason, pid, port, error } = data;
		if (started === true && isPort(port) && typeof pid === 'number') {
			return { installed: true, started: true, alreadyRunning: false, pid, port };
		}
		if (started === false && alreadyRunning === true && isPort(port) && typeof pid === 'number') {
			return { installed: true, started: true, alreadyRunning: true, pid, port };
		}
		if (started === false && reason === 'desktop-running' && typeof pid === 'number') {
			return { installed: true, started: false, reason: 'desktop-running', pid };
		}
		if (typeof error === 'string') {
			throw new RemoteDiscoveryError(
				'refused',
				`maestro-cli on ${label} could not start a host: ${safeText(error)}`
			);
		}
	}

	const unsupported = unsupportedVerb(run, 'host start');
	if (unsupported) throw unsupported;
	throw new RemoteDiscoveryError(
		'malformed',
		`maestro-cli on ${label} returned output that is not a host start report (exit ${String(run.exitCode)}).`
	);
}

/** How a remote's Maestro version compares with this one. */
export type RemoteVersionSkew = 'none' | 'remote-older' | 'remote-newer' | 'unknown';

/**
 * Compare a remote's version with this side's. Case is folded first, because builds stamp `-RC`
 * where manifests write `-rc`. `unknown` when either side did not report one.
 */
export function remoteVersionSkew(local?: string, remote?: string): RemoteVersionSkew {
	if (!local || !remote) return 'unknown';
	const order = compareVersions(remote.toLowerCase(), local.toLowerCase());
	return order === 0 ? 'none' : order < 0 ? 'remote-older' : 'remote-newer';
}
