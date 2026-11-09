// `maestro-cli remote-host` - the `maestro-cli host` on an SSH remote, seen from this machine
// (Federation over SSH, #1716).
//
// `status` asks the remote for its host over one SSH call (`discoverRemoteHost()`) and reports
// whether Maestro is installed there, whether a host is running, its version, and how that version
// compares with this CLI. `start` runs `maestro-cli host start` on the remote when no host is
// running (decision D2: the host runs as the SSH user), then reports status. Every SSH call is
// made one after the other, never side by side: tailcat remotes fail under concurrent dials.
//
// Only a remote opted in to Federation is dialed (decision D8). The endpoint's token and CLI secret
// stay in memory: nothing here prints them, in either output form.

import {
	RemoteDiscoveryError,
	discoverRemoteHost,
	remoteVersionSkew,
	startRemoteHost,
	type DiscoverRemoteHostOptions,
	type RemoteCliLauncher,
	type RemoteHostDiscovery,
	type RemoteLingerWarning,
	type RemoteVersionSkew,
} from '../../shared/maestro-lib/client/remote-discovery';
import type { SshRemoteConfig } from '../../shared/types';
import { ExitCode } from '../exit-codes';
import { colorize, formatError, formatSuccess } from '../output/formatter';
import { formatLingerWarning } from '../services/host-linger';
import {
	PeerResolveError,
	findPeerRemote,
	requireFederationRemote,
} from '../services/peer-resolver';
import { readSshRemotes, resolveSshRemoteId } from '../services/storage';

export interface RemoteHostOptions {
	json?: boolean;
	/** Seconds each SSH call may take. Default 60. */
	timeout?: string | number;
}

/**
 * What `remote-host status --json` prints. Never holds the token or the CLI secret. `linger: false`
 * (with `lingerFix`) is the remote's own warning, passed through: the host there may stop when the
 * SSH session that started it ends.
 */
export interface RemoteHostStatusReport extends RemoteLingerWarning {
	remote: { id: string; name: string };
	installed: boolean;
	/** `installed: false` only: what to install on the remote. */
	fix?: string;
	running?: boolean;
	launcher?: RemoteCliLauncher;
	/** The remote `maestro-cli --version`. */
	cliVersion?: string;
	/** The running host's version, from its discovery file. */
	hostVersion?: string;
	pid?: number;
	/** The host's port on the remote's loopback. */
	port?: number;
	/** This CLI's version. */
	localVersion: string;
	/** The running host's version (else the remote CLI's) against this CLI. */
	skew: RemoteVersionSkew;
}

/** What `remote-host` needs from the world, so a test can stand in for it. */
export interface RemoteHostDeps {
	readRemotes(): SshRemoteConfig[];
	resolveRemoteId(ref: string): string;
	discover: typeof discoverRemoteHost;
	start: typeof startRemoteHost;
}

const defaultDeps: RemoteHostDeps = {
	readRemotes: readSshRemotes,
	resolveRemoteId: resolveSshRemoteId,
	discover: discoverRemoteHost,
	start: startRemoteHost,
};

class RemoteHostUsageError extends Error {
	constructor(
		message: string,
		readonly exitCode: ExitCode = ExitCode.GeneralError
	) {
		super(message);
	}
}

function fail(options: RemoteHostOptions, message: string, code: ExitCode): void {
	if (options.json) console.log(JSON.stringify({ error: message }, null, 2));
	else console.error(formatError(message));
	process.exitCode = code;
}

function discoveryOptions(options: RemoteHostOptions): DiscoverRemoteHostOptions {
	if (options.timeout === undefined) return {};
	const parsed = Number(options.timeout);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new RemoteHostUsageError(
			'--timeout must be a positive number of seconds',
			ExitCode.InvalidUsage
		);
	}
	return { timeoutMs: Math.round(parsed * 1000) };
}

export function buildRemoteHostStatusReport(
	remote: SshRemoteConfig,
	found: RemoteHostDiscovery,
	localVersion: string
): RemoteHostStatusReport {
	const base = { remote: { id: remote.id, name: remote.name }, localVersion };
	if (!found.installed) {
		return { ...base, installed: false, fix: found.fix, skew: 'unknown' };
	}
	const common = {
		...base,
		installed: true,
		launcher: found.launcher,
		...(found.cliVersion ? { cliVersion: found.cliVersion } : {}),
		...(found.linger === false ? { linger: false as const } : {}),
		...(found.linger === false && found.lingerFix ? { lingerFix: found.lingerFix } : {}),
	};
	if (!found.running) {
		return {
			...common,
			running: false,
			skew: remoteVersionSkew(localVersion, found.cliVersion),
		};
	}
	const { endpoint } = found;
	return {
		...common,
		running: true,
		...(endpoint.version ? { hostVersion: endpoint.version } : {}),
		pid: endpoint.pid,
		port: endpoint.port,
		skew: remoteVersionSkew(localVersion, endpoint.version ?? found.cliVersion),
	};
}

function describeSkew(report: RemoteHostStatusReport): string {
	const remoteVersion = report.hostVersion ?? report.cliVersion;
	switch (report.skew) {
		case 'none':
			return `same as this CLI (${report.localVersion})`;
		case 'remote-older':
			return colorize(
				'yellow',
				`remote ${remoteVersion} is older than this CLI ${report.localVersion}: upgrade Maestro on the remote`
			);
		case 'remote-newer':
			return colorize(
				'yellow',
				`remote ${remoteVersion} is newer than this CLI ${report.localVersion}: upgrade Maestro here`
			);
		case 'unknown':
			return `unknown (this CLI is ${report.localVersion})`;
	}
}

export function formatRemoteHostStatus(report: RemoteHostStatusReport): string {
	const lines = [`Remote: ${report.remote.name} (${report.remote.id})`];
	if (!report.installed) {
		lines.push(`Installed: ${colorize('yellow', 'no')}`, `Fix: ${report.fix}`);
		return lines.join('\n');
	}
	const via = report.launcher === 'app-bundle' ? 'Maestro.app bundle' : 'maestro-cli on PATH';
	lines.push(`Installed: yes (${via}${report.cliVersion ? `, ${report.cliVersion}` : ''})`);
	lines.push(
		report.running
			? `Host: running (pid ${report.pid}, port ${report.port}${report.hostVersion ? `, version ${report.hostVersion}` : ''})`
			: `Host: ${colorize('yellow', 'not running')} (start it with: maestro-cli remote-host start ${report.remote.id})`
	);
	lines.push(`Version skew: ${describeSkew(report)}`);
	if (report.linger === false) {
		lines.push(
			colorize(
				'yellow',
				formatLingerWarning(
					report.lingerFix ?? 'loginctl enable-linger <ssh user>',
					report.remote.name
				)
			)
		);
	}
	return lines.join('\n');
}

function reportError(options: RemoteHostOptions, error: unknown): void {
	if (error instanceof RemoteHostUsageError || error instanceof PeerResolveError) {
		fail(options, error.message, error.exitCode);
		return;
	}
	if (error instanceof RemoteDiscoveryError) {
		const code =
			error.code === 'timeout'
				? ExitCode.Timeout
				: error.code === 'unsupported'
					? ExitCode.Unsupported
					: ExitCode.GeneralError;
		if (options.json) {
			console.log(JSON.stringify({ error: error.message, code: error.code }, null, 2));
		} else {
			console.error(formatError(error.message));
		}
		process.exitCode = code;
		return;
	}
	throw error;
}

/** Exit 0 with a running host, 3 (`NotRunning`) when none runs or Maestro is not installed. */
function printStatus(options: RemoteHostOptions, report: RemoteHostStatusReport): void {
	console.log(options.json ? JSON.stringify(report, null, 2) : formatRemoteHostStatus(report));
	if (!report.running) process.exitCode = ExitCode.NotRunning;
}

export async function remoteHostStatus(
	ref: string,
	options: RemoteHostOptions,
	localVersion: string,
	overrides: Partial<RemoteHostDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const remote = findPeerRemote(ref, {
			readRemotes: deps.readRemotes,
			resolveRemoteId: deps.resolveRemoteId,
		});
		requireFederationRemote(remote);
		const opts = discoveryOptions(options);
		const found = await deps.discover(remote, opts);
		printStatus(options, buildRemoteHostStatusReport(remote, found, localVersion));
	} catch (error) {
		reportError(options, error);
	}
}

export async function remoteHostStart(
	ref: string,
	options: RemoteHostOptions,
	localVersion: string,
	overrides: Partial<RemoteHostDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const remote = findPeerRemote(ref, {
			readRemotes: deps.readRemotes,
			resolveRemoteId: deps.resolveRemoteId,
		});
		requireFederationRemote(remote);
		const opts = discoveryOptions(options);
		const before = await deps.discover(remote, opts);
		if (!before.installed || before.running) {
			// Nothing to start: either nothing to start it with, or it is already up.
			const report = buildRemoteHostStatusReport(remote, before, localVersion);
			if (options.json) {
				console.log(JSON.stringify({ started: false, ...report }, null, 2));
				if (!report.running) process.exitCode = ExitCode.NotRunning;
			} else {
				if (report.running) console.log(`A host is already running on ${remote.name}.`);
				printStatus(options, report);
			}
			return;
		}

		if (!options.json) console.log(`Starting the host on ${colorize('cyan', remote.name)}...`);
		const started = await deps.start(remote, opts);
		if (started.installed && !started.started) {
			fail(
				options,
				`The Maestro desktop app is running on ${remote.name} (pid ${started.pid}) and is the host there, ` +
					'so a headless host cannot start. Quit the desktop app on the remote to run `maestro-cli host` instead.',
				ExitCode.GeneralError
			);
			return;
		}

		// The start reply has no version or token: the status after it is the one source of truth.
		const after = await deps.discover(remote, opts);
		const report = buildRemoteHostStatusReport(remote, after, localVersion);
		if (options.json) {
			console.log(JSON.stringify({ started: Boolean(report.running), ...report }, null, 2));
			if (!report.running) process.exitCode = ExitCode.GeneralError;
			return;
		}
		if (report.running) console.log(formatSuccess(`Host started on ${remote.name}`));
		console.log(formatRemoteHostStatus(report));
		if (!report.running) {
			console.error(
				formatError(`The host on ${remote.name} started but is not answering discovery yet.`)
			);
			process.exitCode = ExitCode.GeneralError;
		}
	} catch (error) {
		reportError(options, error);
	}
}
