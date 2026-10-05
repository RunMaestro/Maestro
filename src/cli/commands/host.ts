// `maestro-cli host` - run Maestro's runtime detached, with no desktop, and control that process.
//
// `start` runs the library runtime in a process that outlives its parent and serves it over the
// same WebSocket bridge the desktop does, so a TUI (or any `maestro-cli` command) attaches the way
// it attaches to a desktop and an Auto Run keeps going after the TUI quits or an SSH session drops.
// `status` and `stop` reach that process over the same socket (two messages the desktop does not
// have; see `src/shared/maestro-lib/client/host-control.ts`), not through signals, so `stop` can
// refuse while work is in flight. The process itself is `services/runtime-host.ts`.

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { formatDurationHuman } from '../../shared/duration';
import {
	RUNTIME_LOCK_SPEC,
	createFileLogger,
	createProcessLock,
	hostHasWork,
	isPidAlive,
	readCliServerInfoFrom,
	requestHostStatus,
	requestHostStop,
	resolveMaestroPaths,
	setMaestroLibLogger,
	type HostCueState,
	type HostStatusReport,
	type HostStopReply,
	type HostWork,
	type MaestroPaths,
	type RuntimeLockInfo,
	type RuntimeLockMode,
} from '../../shared/maestro-lib';
import { ExitCode } from '../exit-codes';
import { startRuntimeHost } from '../services/runtime-host';

export interface HostCommandOptions {
	dataDir?: string;
	dev?: boolean;
	json?: boolean;
	/** `start` only: serve in this process instead of detaching. What the detached child itself runs. */
	foreground?: boolean;
	/** `start` only: a port to listen on. Default: any free one. */
	port?: string | number;
	/** `stop` only: stop even with a turn or run in flight. */
	force?: boolean;
}

/** How long `start` waits for the child to publish, and `stop` for it to exit. */
const START_WAIT_MS = 20_000;
const STOP_WAIT_MS = 30_000;
const POLL_MS = 100;
const LOG_TAIL_LINES = 15;

export const HOST_LOG_FILE_NAME = 'maestro-host.log';

type HostPaths = Pick<
	MaestroPaths,
	'userDataDir' | 'productionDataDir' | 'settingsFile' | 'cliServerFile'
>;

/** The data directory the way the TUI resolves it: `--data-dir` wins, `--dev` redirects. */
export function resolveHostPaths(options: HostCommandOptions): HostPaths {
	return resolveMaestroPaths({
		env: options.dataDir ? { ...process.env, MAESTRO_USER_DATA: options.dataDir } : process.env,
		...(options.dev ? { isDevelopment: true } : {}),
	});
}

export function hostLogFilePath(userDataDir: string): string {
	return path.join(userDataDir, 'logs', HOST_LOG_FILE_NAME);
}

/** What `start` needs from the operating system, so a test can stand in for it. */
export interface HostCommandDeps {
	spawnDetached(args: string[], env: NodeJS.ProcessEnv, logFile: string): DetachedChild;
	requestStatus: typeof requestHostStatus;
	requestStop: typeof requestHostStop;
	isPidAlive(pid: number): boolean;
	sleep(ms: number): Promise<void>;
	/** The bundle to re-run as the detached child. */
	cliScript: string;
}

export interface DetachedChild {
	pid: number | undefined;
	/** Has the child exited, and with what? */
	exited(): { code: number | null } | undefined;
}

function spawnDetachedChild(
	args: string[],
	env: NodeJS.ProcessEnv,
	logFile: string
): DetachedChild {
	fs.mkdirSync(path.dirname(logFile), { recursive: true });
	const fd = fs.openSync(logFile, 'a');
	try {
		const child = spawn(process.execPath, args, {
			detached: true,
			stdio: ['ignore', fd, fd],
			env,
		});
		let exit: { code: number | null } | undefined;
		child.on('exit', (code) => {
			exit = { code };
		});
		child.on('error', () => {
			exit = { code: null };
		});
		child.unref();
		return { pid: child.pid, exited: () => exit };
	} finally {
		fs.closeSync(fd);
	}
}

const defaultDeps: HostCommandDeps = {
	spawnDetached: spawnDetachedChild,
	requestStatus: requestHostStatus,
	requestStop: requestHostStop,
	isPidAlive,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	cliScript: process.argv[1] ?? '',
};

function say(options: HostCommandOptions, payload: unknown, human: string): void {
	console.log(options.json ? JSON.stringify(payload, null, 2) : human);
}

function fail(options: HostCommandOptions, message: string, code = ExitCode.GeneralError): void {
	if (options.json) console.log(JSON.stringify({ error: message }, null, 2));
	else console.error(`Error: ${message}`);
	process.exitCode = code;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The last lines of the host's log, for a start that failed before it could say why. */
function logTail(file: string): string {
	try {
		return fs.readFileSync(file, 'utf-8').trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n');
	} catch {
		return '';
	}
}

/** A live host's discovery record, or undefined. The pid is checked, not trusted. */
function liveHost(userDataDir: string, deps: Pick<HostCommandDeps, 'isPidAlive'>) {
	const info = readCliServerInfoFrom(userDataDir);
	return info && deps.isPidAlive(info.pid) ? info : undefined;
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export async function hostStart(
	options: HostCommandOptions,
	cliVersion?: string,
	overrides: Partial<HostCommandDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	const paths = resolveHostPaths(options);
	return options.foreground
		? runForeground(options, paths, cliVersion)
		: startDetached(options, paths, deps);
}

async function startDetached(
	options: HostCommandOptions,
	paths: HostPaths,
	deps: HostCommandDeps
): Promise<void> {
	const running = liveHost(paths.userDataDir, deps);
	if (running) {
		say(
			options,
			{ started: false, alreadyRunning: true, pid: running.pid, port: running.port },
			`A host is already running (pid ${running.pid}, port ${running.port}).`
		);
		return;
	}

	const logFile = hostLogFilePath(paths.userDataDir);
	// The child is this same bundle in `--foreground`, with the directory already resolved.
	const args = [
		deps.cliScript,
		'host',
		'start',
		'--foreground',
		'--data-dir',
		paths.userDataDir,
		...(options.dev ? ['--dev'] : []),
		...(options.port !== undefined ? ['--port', String(options.port)] : []),
	];
	const child = deps.spawnDetached(
		args,
		{ ...process.env, MAESTRO_USER_DATA: paths.userDataDir },
		logFile
	);
	if (child.pid === undefined) {
		fail(options, 'Could not start the host process.');
		return;
	}

	for (let waited = 0; waited < START_WAIT_MS; waited += POLL_MS) {
		const info = readCliServerInfoFrom(paths.userDataDir);
		if (info?.pid === child.pid && deps.isPidAlive(child.pid)) {
			say(
				options,
				{ started: true, pid: info.pid, port: info.port, log: logFile },
				`Host started (pid ${info.pid}, port ${info.port}). Log: ${logFile}`
			);
			return;
		}
		if (child.exited()) {
			const tail = logTail(logFile);
			fail(
				options,
				`The host exited before it was ready.${tail ? `\n${tail}` : ` See ${logFile}.`}`
			);
			return;
		}
		await deps.sleep(POLL_MS);
	}
	fail(options, `The host did not publish within ${START_WAIT_MS / 1000}s. See ${logFile}.`);
}

async function runForeground(
	options: HostCommandOptions,
	paths: HostPaths,
	cliVersion?: string
): Promise<void> {
	// Everything the runtime and the Cue engine read by environment lands on this directory too.
	process.env.MAESTRO_USER_DATA = paths.userDataDir;
	const logFile = hostLogFilePath(paths.userDataDir);
	setMaestroLibLogger(createFileLogger(logFile));

	let host;
	try {
		host = await startRuntimeHost({
			paths,
			moduleDirectory: __dirname,
			...(cliVersion ? { version: cliVersion } : {}),
			...(options.port !== undefined ? { port: Number(options.port) } : {}),
			log: (line) => console.log(line),
		});
	} catch (error) {
		fail(options, error instanceof Error ? error.message : String(error));
		return;
	}

	const shutdown = (): void => void host.stop();
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
	say(
		options,
		{ started: true, pid: process.pid, port: host.server.port },
		`Host started (pid ${process.pid}, port ${host.server.port}).`
	);
	await host.stopped;
	process.exit(ExitCode.Success);
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function describeCue(cue: HostCueState): string {
	switch (cue.state) {
		case 'running':
			return 'running';
		case 'disabled':
			return 'off';
		case 'held':
			return `not running here: ${cue.mode} pid ${cue.pid} holds the Cue lock`;
		case 'failed':
			return `failed to start: ${cue.reason}`;
	}
}

function describeWork(work: HostWork): string {
	if (!hostHasWork(work)) return 'idle';
	const parts = [plural(work.turns, 'turn')];
	for (const run of work.runs) {
		parts.push(`${run.kind} run on ${run.agentId}${run.paused ? ' (paused)' : ''}`);
	}
	return parts.join(', ');
}

export function formatHostStatus(report: HostStatusReport): string {
	return [
		`Host: pid ${report.pid}, up ${formatDurationHuman(report.uptimeMs)}${report.version ? `, version ${report.version}` : ''}`,
		`Lock: ${report.lock.mode} pid ${report.lock.pid}, since ${report.lock.startedAt}`,
		`Clients: ${report.clients}`,
		`Work: ${describeWork(report.work)}`,
		`Cue: ${describeCue(report.cue)}`,
	].join('\n');
}

/** Who holds the runtime lock when no host answers: a TUI hosting in process, or nobody. */
function lockHolder(userDataDir: string): RuntimeLockInfo | null {
	return createProcessLock<RuntimeLockMode>(userDataDir, RUNTIME_LOCK_SPEC).holder();
}

export async function hostStatus(
	options: HostCommandOptions,
	overrides: Partial<HostCommandDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	const { userDataDir } = resolveHostPaths(options);
	try {
		const report = await deps.requestStatus(userDataDir);
		say(options, { running: true, ...report }, formatHostStatus(report));
	} catch (error) {
		const holder = lockHolder(userDataDir);
		const reachable = liveHost(userDataDir, deps);
		const reason = reachable
			? `Pid ${reachable.pid} is alive but did not answer: ${error instanceof Error ? error.message : String(error)}`
			: 'No host is running.';
		say(
			options,
			{ running: false, reason, lockHolder: holder },
			holder
				? `${reason}\nLock: ${holder.mode} pid ${holder.pid}, since ${holder.startedAt}`
				: reason
		);
		process.exitCode = ExitCode.NotRunning;
	}
}

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

function describeRefusal(reply: Extract<HostStopReply, { stopping: false }>): string {
	return `The host has work in flight (${describeWork(reply.work)}). Stop it anyway with --force.`;
}

export async function hostStop(
	options: HostCommandOptions,
	overrides: Partial<HostCommandDeps> = {}
): Promise<void> {
	const deps = { ...defaultDeps, ...overrides };
	const { userDataDir } = resolveHostPaths(options);
	const info = liveHost(userDataDir, deps);
	if (!info) {
		say(options, { stopped: false, reason: 'not-running' }, 'No host is running.');
		return;
	}

	let reply: HostStopReply;
	try {
		reply = await deps.requestStop(userDataDir, { force: options.force });
	} catch (error) {
		fail(options, error instanceof Error ? error.message : String(error));
		return;
	}
	if (!reply.stopping) {
		if (options.json) console.log(JSON.stringify({ stopped: false, ...reply }, null, 2));
		else console.error(describeRefusal(reply));
		process.exitCode = ExitCode.GeneralError;
		return;
	}

	for (let waited = 0; waited < STOP_WAIT_MS; waited += POLL_MS) {
		if (!deps.isPidAlive(info.pid)) {
			say(options, { stopped: true, pid: info.pid }, `Host stopped (pid ${info.pid}).`);
			return;
		}
		await deps.sleep(POLL_MS);
	}
	// It was told to stop and is finishing: recording a run's end can take a moment.
	say(
		options,
		{ stopped: false, stopping: true, pid: info.pid },
		`The host (pid ${info.pid}) is still shutting down.`
	);
	process.exitCode = ExitCode.Timeout;
}
