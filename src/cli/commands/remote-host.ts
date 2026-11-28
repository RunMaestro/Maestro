// `maestro-cli remote-host` - the `maestro-cli host` on an SSH remote, seen from this machine
// (Federation over SSH, #1716).
//
// `status` asks the remote for its host over one SSH call (`discoverRemoteHost()`) and reports
// whether Maestro is installed there, whether a host is running, its version, and how that version
// compares with this CLI. `start` runs `maestro-cli host start` on the remote when no host is
// running (decision D2: the host runs as the SSH user), then reports status. Every SSH call is
// made one after the other, never side by side: tailcat remotes fail under concurrent dials.
//
// `install` copies this CLI to the remote (`setupRemoteHost()`, the same path as the desktop's Make
// Federated), with Node.js and SQLite for the remote's own platform, and with `--start` starts the
// host there.
//
// A remote that opted out of Federation (`--federation off`) is never dialed. The endpoint's token
// and CLI secret stay in memory: nothing here prints them, in either output form.

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
import {
	DEFAULT_INSTALL_TIMEOUT_MS,
	RemoteInstallError,
	resolveLocalCliBundle,
	setupRemoteHost,
	type LocalCliBundle,
	type RemoteHostSetupResult,
} from '../../shared/maestro-lib/client/remote-install';
import { peerIdFor } from '../../shared/maestro-lib/client/peer-connection';
import { describeRemoteService } from '../../shared/maestro-lib/client/remote-service';
import {
	RemoteHostStopError,
	describeRemoteHostStop,
	desktopHostMessage,
	stopRemoteHost,
	surveyRemoteHost,
	type RemoteHostStopResult,
	type RemoteServiceStatus,
} from '../../shared/maestro-lib/client/remote-uninstall';
import type { SshRemoteConfig } from '../../shared/types';
import { ExitCode } from '../exit-codes';
import { colorize, formatError, formatSuccess } from '../output/formatter';
import { formatLingerWarning } from '../services/host-linger';
import {
	PeerResolveError,
	findPeerRemote,
	requireFederationRemote,
} from '../services/peer-resolver';
import { readSshRemotes, resolveSshRemoteId, writeSshRemotes } from '../services/storage';
import { federationTurnedOffNote, withFederationOff } from '../../shared/federationRemote';
import { nudgeDesktopReconnect } from './federation';

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
	/** The boot service Maestro registered there (`kind: 'none'` when there is none). */
	service?: RemoteServiceStatus;
	/** Why the boot service could not be read, when it could not. */
	serviceError?: string;
}

/** What `remote-host` needs from the world, so a test can stand in for it. */
export interface RemoteHostDeps {
	readRemotes(): SshRemoteConfig[];
	resolveRemoteId(ref: string): string;
	discover: typeof discoverRemoteHost;
	start: typeof startRemoteHost;
	setup: typeof setupRemoteHost;
	survey: typeof surveyRemoteHost;
	stop: typeof stopRemoteHost;
	/** Store the SSH remote list: stop and uninstall switch the remote's Federation off. */
	writeRemotes(remotes: SshRemoteConfig[]): void;
	/** This CLI's own bundle: the file the running process loaded, and its prompts beside it. */
	localBundle(version: string): LocalCliBundle;
	/** Tell a running desktop to reload the peer. */
	nudgeDesktop(peer: string): Promise<boolean>;
}

const defaultDeps: RemoteHostDeps = {
	readRemotes: readSshRemotes,
	resolveRemoteId: resolveSshRemoteId,
	discover: discoverRemoteHost,
	start: startRemoteHost,
	setup: setupRemoteHost,
	survey: surveyRemoteHost,
	stop: stopRemoteHost,
	writeRemotes: (remotes) => writeSshRemotes(remotes),
	localBundle: (version) => resolveLocalCliBundle(__filename, version),
	nudgeDesktop: nudgeDesktopReconnect,
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

/** One line for the boot service, or null when it was not read. */
export function formatRemoteServiceStatus(report: RemoteHostStatusReport): string | null {
	if (report.serviceError)
		return colorize('yellow', `Service: could not read (${report.serviceError})`);
	const service = report.service;
	if (!service) return null;
	if (service.kind === 'none') return 'Service: none registered';
	const manager = service.kind === 'systemd' ? 'systemd user unit' : 'launchd agent';
	const boot = service.enabled
		? service.kind === 'systemd'
			? 'starts the host at boot'
			: 'starts the host at login'
		: colorize('yellow', 'disabled');
	return `Service: ${manager} registered, ${boot}${service.active ? ', running' : ''} (${service.file})`;
}

export function formatRemoteHostStatus(report: RemoteHostStatusReport): string {
	const lines = [`Remote: ${report.remote.name} (${report.remote.id})`];
	const serviceLine = formatRemoteServiceStatus(report);
	if (!report.installed) {
		lines.push(`Installed: ${colorize('yellow', 'no')}`, `Fix: ${report.fix}`);
		if (serviceLine) lines.push(serviceLine);
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
	if (serviceLine) lines.push(serviceLine);
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
	if (error instanceof RemoteInstallError) {
		const code = error.code === 'timeout' ? ExitCode.Timeout : ExitCode.GeneralError;
		if (options.json) {
			console.log(JSON.stringify({ error: error.message, code: error.code }, null, 2));
		} else {
			console.error(formatError(error.message));
		}
		process.exitCode = code;
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
		const report = buildRemoteHostStatusReport(remote, found, localVersion);
		// A second call, after the first (never side by side): the boot service, read-only.
		try {
			report.service = (await deps.survey(remote, opts)).service;
		} catch (error) {
			if (!(error instanceof RemoteHostStopError)) throw error;
			report.serviceError = error.message;
		}
		printStatus(options, report);
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

export interface RemoteHostInstallOptions extends RemoteHostOptions {
	/** Start the host once the CLI is in place. */
	start?: boolean;
	/** Install even over a `maestro-cli` Maestro did not install. */
	force?: boolean;
	/** Replace a running host on an older version: stop it, upgrade, start it again. */
	restart?: boolean;
	/** `--no-service` sets this false: skip the systemd unit or launchd agent. */
	service?: boolean;
}

function installTimeoutMs(options: RemoteHostOptions): number {
	if (options.timeout === undefined) return DEFAULT_INSTALL_TIMEOUT_MS;
	const parsed = Number(options.timeout);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new RemoteHostUsageError(
			'--timeout must be a positive number of seconds',
			ExitCode.InvalidUsage
		);
	}
	return Math.round(parsed * 1000);
}

const CLI_ACTION_TEXT: Record<RemoteHostSetupResult['cli'], string> = {
	installed: 'installed',
	upgraded: 'upgraded',
	current: 'already current',
	newer: 'left alone (the remote runs a newer version)',
};

/** The human form of a setup result. */
export function formatRemoteHostSetup(
	remote: SshRemoteConfig,
	result: RemoteHostSetupResult
): string {
	const lines = [
		`Remote: ${remote.name} (${remote.id})`,
		`maestro-cli: ${CLI_ACTION_TEXT[result.cli]}${result.cliVersion ? ` (${result.cliVersion})` : ''}`,
	];
	if (result.install) {
		const node =
			result.install.nodeSource === 'downloaded'
				? 'downloaded from nodejs.org'
				: result.install.nodeSource === 'cached'
					? 'installed earlier'
					: "the remote's own";
		lines.push(
			`Platform: ${result.install.platform}`,
			`Node.js: ${result.install.nodeVersion} (${node})`
		);
	}
	if (result.start) {
		if (!result.start.installed)
			lines.push(`Host: ${colorize('yellow', 'not started')} (${result.start.fix})`);
		else if (!result.start.started)
			lines.push('Host: the Maestro desktop app on the remote is the host there');
		else
			lines.push(
				`Host: ${result.start.alreadyRunning ? 'already running' : 'started'} (pid ${result.start.pid}, port ${result.start.port})`
			);
	}
	if (result.service) lines.push(`Service: ${describeRemoteService(result.service)}`);
	if (result.serviceError) {
		lines.push(colorize('yellow', `Service: ${result.serviceError}`));
	}
	if (result.lingerFix) {
		lines.push(colorize('yellow', formatLingerWarning(result.lingerFix, remote.name)));
	}
	return lines.join('\n');
}

/**
 * `remote-host install <ssh-remote>`: put this CLI on the remote (or upgrade an older one), and
 * with `--start` start the host there. Exit 0 when the CLI is in place (and, with `--start`, the
 * host serves); the desktop, when it runs, reloads the peer right away.
 */
export async function remoteHostInstall(
	ref: string,
	options: RemoteHostInstallOptions,
	localVersion: string,
	overrides: Partial<RemoteHostDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const remotes = deps.readRemotes();
		const remote = findPeerRemote(ref, {
			readRemotes: () => remotes,
			resolveRemoteId: deps.resolveRemoteId,
		});
		requireFederationRemote(remote);
		const timeoutMs = installTimeoutMs(options);
		const bundle = deps.localBundle(localVersion);
		if (!options.json) {
			console.log(`Setting up a Maestro host on ${colorize('cyan', remote.name)}...`);
		}
		const result = await deps.setup(remote, bundle, {
			timeoutMs,
			start: options.start === true,
			force: options.force === true,
			restart: options.restart === true,
			service: options.service !== false,
		});
		// A desktop app on the remote is the host there too (`desktop-running`).
		const serving = result.start !== undefined && result.start.installed;
		if (serving) await deps.nudgeDesktop(peerIdFor(remote, remotes));
		if (options.json) {
			console.log(
				JSON.stringify({ remote: { id: remote.id, name: remote.name }, ...result }, null, 2)
			);
		} else {
			console.log(formatSuccess(`maestro-cli is ready on ${remote.name}`));
			console.log(formatRemoteHostSetup(remote, result));
		}
		if (result.start && !serving) process.exitCode = ExitCode.GeneralError;
	} catch (error) {
		reportError(options, error);
	}
}

export interface RemoteHostStopOptions extends RemoteHostOptions {
	/** Stop even though the host holds agents. */
	force?: boolean;
}

export interface RemoteHostUninstallOptions extends RemoteHostStopOptions {
	/** Also remove the host's data directory (refused while the host holds an agent). */
	purgeData?: boolean;
}

/** The human form of a stop or uninstall result. */
export function formatRemoteHostStop(
	remote: SshRemoteConfig,
	result: RemoteHostStopResult,
	uninstall: boolean
): string {
	const lines = [`Remote: ${remote.name} (${remote.id})`];
	if (result.outcome !== 'done') {
		lines.push(describeRemoteHostStop(remote, result, uninstall));
		if (result.outcome === 'agents-held') {
			lines.push(
				'Move them back with `maestro-cli unlift <agent>`, or pass --force to leave them behind.'
			);
		}
		if (result.outcome === 'host-unknown') lines.push('Stop it anyway with --force.');
		return lines.join('\n');
	}
	lines.push(
		`Host: ${result.hostStopped ? `stopped${result.survey.pid ? ` (pid ${result.survey.pid})` : ''}` : 'was not running'}`
	);
	if (result.survey.service.kind !== 'none') {
		lines.push(
			`Service: ${result.serviceLeftAtBoot ? colorize('red', 'NOT disabled: the host comes back at boot') : result.serviceDisabled ? 'disabled, so the host does not come back after a reboot' : 'removed'}`
		);
	}
	for (const item of result.removed) lines.push(`Removed: ${item}`);
	for (const item of result.kept) lines.push(`Kept: ${item}`);
	for (const warning of result.warnings) lines.push(colorize('yellow', warning));
	return lines.join('\n');
}

function stopTimeoutMs(options: RemoteHostOptions): number | undefined {
	return discoveryOptions(options).timeoutMs;
}

async function runRemoteHostStop(
	ref: string,
	options: RemoteHostUninstallOptions,
	uninstall: boolean,
	overrides: Partial<RemoteHostDeps>
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	try {
		const remote = findPeerRemote(ref, {
			readRemotes: deps.readRemotes,
			resolveRemoteId: deps.resolveRemoteId,
		});
		// No `requireFederationRemote()`: undoing what Maestro set up is what a person who turned
		// Federation off for this remote asks for, and it changes only Maestro's own files.
		if (options.purgeData && !uninstall) {
			throw new RemoteHostUsageError('--purge-data belongs to uninstall', ExitCode.InvalidUsage);
		}
		const timeoutMs = stopTimeoutMs(options);
		if (!options.json) {
			console.log(
				`${uninstall ? 'Removing' : 'Stopping'} the Maestro host on ${colorize('cyan', remote.name)}...`
			);
		}
		const result = await deps.stop(remote, {
			uninstall,
			force: options.force === true,
			purgeData: options.purgeData === true,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		});
		const refused =
			result.outcome === 'desktop-host' ||
			result.outcome === 'host-unknown' ||
			result.outcome === 'agents-held' ||
			result.outcome === 'purge-refused';
		// Automatic Federation honors the remote's own switch: off, it never starts this host again.
		const switched =
			result.outcome === 'done' ? withFederationOff(deps.readRemotes(), remote.id) : null;
		if (switched) deps.writeRemotes(switched);
		// --purge-data that the last check on the remote turned down is not the success asked for.
		const purgeKept = result.outcome === 'done' && options.purgeData === true && !result.purged;
		// A boot service that could not be disabled brings the host back: a failure, not a stop.
		const bootLeft = result.outcome === 'done' && result.serviceLeftAtBoot;
		if (options.json) {
			const { survey, ...rest } = result;
			console.log(
				JSON.stringify(
					{
						remote: { id: remote.id, name: remote.name },
						...rest,
						...(result.outcome === 'desktop-host'
							? { error: desktopHostMessage(remote, survey.pid) }
							: {}),
						foreign: survey.foreign,
						service: survey.service,
						...(survey.dataDir ? { dataDir: survey.dataDir } : {}),
						...(switched ? { federationOff: true } : {}),
					},
					null,
					2
				)
			);
		} else {
			if (result.outcome === 'done' && !bootLeft) {
				console.log(
					formatSuccess(
						uninstall
							? `Maestro's host is removed from ${remote.name}`
							: `Host stopped on ${remote.name}`
					)
				);
			}
			const text = formatRemoteHostStop(remote, result, uninstall);
			if (refused || bootLeft) console.error(text);
			else console.log(text);
			if (switched) console.log(federationTurnedOffNote(remote.name));
		}
		if (refused || purgeKept || bootLeft) process.exitCode = ExitCode.GeneralError;
	} catch (error) {
		if (error instanceof RemoteHostStopError) {
			const code = error.code === 'timeout' ? ExitCode.Timeout : ExitCode.GeneralError;
			if (options.json) {
				console.log(JSON.stringify({ error: error.message, code: error.code }, null, 2));
			} else {
				console.error(formatError(error.message));
			}
			process.exitCode = code;
			return;
		}
		reportError(options, error);
	}
}

/**
 * `remote-host stop <ssh-remote>`: stop the host and disable its boot service, so it does not come
 * back after a reboot. The install and the host's data stay. Refuses while the host holds agents,
 * unless `--force`; changes nothing where the desktop app is the host.
 */
export function remoteHostStop(
	ref: string,
	options: RemoteHostStopOptions,
	overrides: Partial<RemoteHostDeps> = {}
): Promise<void> {
	return runRemoteHostStop(ref, options, false, overrides);
}

/**
 * `remote-host uninstall <ssh-remote>`: `stop`, then remove the boot service file and Maestro's own
 * install under `~/.maestro`. A `maestro-cli` Maestro did not install is named and left, and so is
 * the data directory unless `--purge-data` (refused while the host holds an agent).
 */
export function remoteHostUninstall(
	ref: string,
	options: RemoteHostUninstallOptions,
	overrides: Partial<RemoteHostDeps> = {}
): Promise<void> {
	return runRemoteHostStop(ref, options, true, overrides);
}
