/**
 * `maestro-cli cue engine` - run Maestro Cue unattended, without the desktop
 * app, and inspect/control that runner.
 *
 * Unlike `cue schedule` / `cue trigger` / `cue list` (which either edit
 * `.maestro/cue.yaml` directly or talk to a RUNNING desktop app over
 * `withMaestroClient`), `start` boots a real `CueEngine` dispatch loop in
 * THIS process - see `src/cli/services/cue-standalone-engine.ts` for what
 * that engine can and cannot do relative to the desktop app's own instance.
 * `stop` / `status` / `inspect` talk to that runner ONLY through the
 * on-disk state it shares with the desktop app (the cross-process lock file,
 * `cue.db`), so `status`/`inspect` report what was last PERSISTED (lock info,
 * DB heartbeat, recent history rows). The runner's live in-memory figures
 * (active runs, queue depth, readiness) are served by its own loopback status
 * server when started with `--status-port` (`src/main/cue/cue-status-server.ts`);
 * `status` reports that port from the lock file.
 */

import {
	isCueEngineLockInForeignPidNamespace,
	isCueEngineLockOwnedByThisProcess,
	readCueEngineLock,
	setCueEngineLockStatusPort,
} from '../../main/cue/cue-engine-lock';
import {
	createCueEngineHealth,
	createEventLoopDelaySource,
} from '../../main/cue/cue-engine-health';
import type { CueStatusServerHandle } from '../../main/cue/cue-status-server';
import { createSystemdNotifier, watchdogIntervalMs } from '../../main/cue/cue-systemd-notify';
import { createCueNotifyWebhook, parseNotifyWebhookUrl } from '../../main/cue/cue-notify-webhook';
import {
	consoleCueLog,
	createStandaloneCueEngine,
	cueLogForFormat,
	type CueLogFormat,
	type StandaloneCueLog,
} from '../services/cue-standalone-engine';
import { startCueTriggerInbox } from '../services/cue-trigger-inbox';
import { readAgentConfigs, readSessions, readSshRemotes } from '../services/storage';
import { SqliteUnavailableError } from '../utils/native-sqlite';
import {
	applyDataDirOption,
	describeDataDirSource,
	requireDataDirOrExit,
} from '../services/data-dir-option';
import { logger } from '../../main/utils/logger';
import type { CueReadinessReport } from '../../main/cue/cue-readiness';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { humanizeDuration } from '../../shared/duration';

export interface CueEngineStartOptions {
	json?: boolean;
	/**
	 * Refuse to start, before the lock or any trigger is armed, when the
	 * readiness check finds a gap (see `cue-readiness.ts`).
	 */
	requireReady?: boolean;
	/** Explicit data directory; wins over MAESTRO_USER_DATA (see data-dir-option.ts). */
	dataDir?: string;
	/** `text` (default) or `json`: one JSON object per log line, on stderr. */
	logFormat?: CueLogFormat;
	/**
	 * Serve /healthz, /readyz and /status on 127.0.0.1 at this port (see
	 * `cue-status-server.ts`). Off when absent.
	 */
	statusPort?: number;
	/** CLI version, reported by /status. Supplied by the command registration. */
	version?: string;
	/**
	 * Seconds a SIGTERM / SIGINT lets runs in flight finish before they are
	 * stopped (see `CueEngine.drain`). Default {@link DEFAULT_DRAIN_TIMEOUT_SECONDS}.
	 */
	drainTimeout?: number;
	/**
	 * Forward notify actions and expired agent logins here (see
	 * cue-notify-webhook.ts). Validated before anything starts; never echoed
	 * back, since its query string or user info may carry a token.
	 */
	notifyWebhook?: string;
}

/** Longest the exit waits for queued systemd messages and webhook POSTs. */
const SYSTEMD_FLUSH_ON_EXIT_MS = 2_000;

/** Default `--drain-timeout`: with the stop ladder's grace it fits systemd's TimeoutStopSec=120. */
export const DEFAULT_DRAIN_TIMEOUT_SECONDS = 90;

export interface CueEngineStopOptions {
	json?: boolean;
	dataDir?: string;
	/** Milliseconds to wait for the lock to clear after signaling before giving up. Mainly for tests. */
	waitMs?: number;
}

export interface CueEngineStatusOptions {
	json?: boolean;
	dataDir?: string;
}

/**
 * Report a `better-sqlite3` that cannot load in this runtime.
 *
 * The message is `SqliteUnavailableError`'s (see `utils/native-sqlite.ts`):
 * the runtime, the ABI the copy it found was built for, and how to fix it.
 * The stack would only bury that. Every verb that needs `cue.db` reports it
 * the same way: this text on stderr, or `{ error: 'sqlite_unavailable' }` as
 * the `--json` result.
 */
function reportSqliteUnavailable(
	error: SqliteUnavailableError,
	options: { json?: boolean },
	log?: StandaloneCueLog
): void {
	if (options.json) {
		console.log(JSON.stringify({ error: 'sqlite_unavailable', message: error.message }, null, 2));
	} else if (log) {
		log('error', error.message);
	} else {
		console.error(`[Cue] ${error.message}`);
	}
}

/**
 * Exit 1 when `better-sqlite3` cannot load in this runtime.
 *
 * `cue.db` needs the native addon, and a dev checkout's copy is built for
 * Electron's ABI (`postinstall` runs `electron-rebuild`), so under plain Node
 * the engine would log the failure from `initCueDb()` and refuse to start.
 * Probing here, before the lock is taken, turns that into the loader's
 * instructions and exit code 1. In the bundle `better-sqlite3` is the lazy
 * shim, whose first constructor call throws `SqliteUnavailableError`; any other
 * error propagates as itself.
 */
async function requireSqliteOrExit(
	options: { json?: boolean },
	log: StandaloneCueLog = consoleCueLog
): Promise<void> {
	try {
		const { default: Database } = await import('better-sqlite3');
		new Database(':memory:').close();
	} catch (error) {
		if (!(error instanceof SqliteUnavailableError)) throw error;
		reportSqliteUnavailable(error, options, log);
		process.exit(1);
	}
}

/**
 * `buildStatusPayload()`, or `null` after reporting a `better-sqlite3` that
 * cannot load (exit code 1). Status figures come from `cue.db`.
 */
async function statusPayloadOrReport(options: {
	json?: boolean;
}): Promise<CueEngineStatusPayload | null> {
	try {
		return await buildStatusPayload();
	} catch (error) {
		if (!(error instanceof SqliteUnavailableError)) throw error;
		reportSqliteUnavailable(error, options);
		process.exitCode = 1;
		return null;
	}
}

/**
 * Run the readiness check over the data directory this command resolved.
 *
 * Dynamic import: the checker reaches the Cue config loader and the provider
 * probes, which a CLI invoked for an unrelated verb should not load (the same
 * reason `cue-standalone-engine.ts` defers its executors).
 */
async function computeCueReadiness(): Promise<CueReadinessReport> {
	const { checkCueReadiness } = await import('../../main/cue/cue-readiness');
	return checkCueReadiness({
		sessions: readSessions(),
		agentConfigs: readAgentConfigs(),
		sshRemotes: readSshRemotes(),
	});
}

/**
 * Log each readiness gap as its own line: names, paths and ids only, so a
 * JSON log line carries the agent and subscription as indexed fields.
 */
function logReadiness(report: CueReadinessReport, log: StandaloneCueLog, level: string): void {
	if (report.ready) {
		log(
			'info',
			`Ready: ${report.agents} agent(s), ${report.workspaces} workspace(s), ${report.subscriptions} subscription(s) checked, no gaps.`
		);
		return;
	}
	for (const gap of report.gaps) {
		log(level, `Not ready [${gap.kind}]: ${gap.message}`, {
			type: 'readinessGap',
			...(gap.agentId ? { sessionId: gap.agentId } : {}),
			...(gap.subscription ? { subscriptionName: gap.subscription } : {}),
		});
	}
	log(level, `Not ready: ${report.gaps.length} gap(s).`);
}

/**
 * Start the standalone engine in THIS process and block until interrupted.
 * `CueEngine.start()` acquires the cross-process lock itself
 * (`cue-engine-lock.ts`) and simply no-ops (with a logged error) if another
 * live engine - desktop or standalone - already holds it, so a double-start
 * here is safe by construction, not by this command's own checking.
 */
export async function cueEngineStart(options: CueEngineStartOptions = {}): Promise<void> {
	// Before anything reads the data directory: every reader resolves it
	// through MAESTRO_USER_DATA, which --data-dir sets.
	const dataDir = applyDataDirOption(options.dataDir);
	// stdout is the command's RESULT channel under --json, and never carries a
	// JSON log stream; every log line then goes to stderr (see CLI-HEADLESS.md).
	if (options.logFormat === 'json') logger.consoleJson();
	const log = cueLogForFormat(options.logFormat, { stderrOnly: options.json });
	// The lock, cue.db and the trigger inbox all create the directory they are
	// handed, so refuse a missing one first.
	requireDataDirOrExit({ json: options.json, log });
	// Fail fast on a bad --notify-webhook, with our own message: commander's
	// would quote the raw value, credentials and all.
	let webhookTarget: ReturnType<typeof parseNotifyWebhookUrl> | undefined;
	if (options.notifyWebhook !== undefined) {
		try {
			webhookTarget = parseNotifyWebhookUrl(options.notifyWebhook);
		} catch (err) {
			const message = (err as Error).message;
			if (options.json) {
				console.log(JSON.stringify({ started: false, code: 'INVALID_OPTIONS', error: message }));
			} else {
				log('error', message);
			}
			process.exit(2);
		}
	}
	log('info', `Data directory: ${dataDir.dir} (from ${describeDataDirSource(dataDir.source)})`);
	await requireSqliteOrExit(options, log);

	// Readiness, before the lock, the trigger inbox or any trigger is armed.
	// Always computed (a server's status endpoint reports it); only
	// --require-ready turns a gap into a refusal.
	const readiness = await computeCueReadiness();
	logReadiness(readiness, log, options.requireReady ? 'error' : 'warn');
	if (options.requireReady && !readiness.ready) {
		if (options.json) {
			console.log(JSON.stringify({ started: false, code: 'NOT_READY', readiness }, null, 2));
		}
		process.exit(1);
	}

	// The one state object every health surface reads (cue-engine-health.ts).
	// The status server, the lock heartbeat (onLockLost) and shutdown all
	// update it; nothing here keeps a parallel flag.
	// Under a systemd watchdog the loop is measured even without a status
	// server: the watchdog pings only while /healthz's rule holds.
	const systemdWatchdog =
		Boolean(process.env.NOTIFY_SOCKET) &&
		watchdogIntervalMs(process.env.WATCHDOG_USEC, process.env.WATCHDOG_PID, process.pid) !== null;
	const health = createCueEngineHealth({
		version: options.version ?? 'unknown',
		dataDir: dataDir.dir,
		refreshReadiness: computeCueReadiness,
		eventLoop:
			options.statusPort !== undefined || systemdWatchdog
				? createEventLoopDelaySource()
				: undefined,
	});
	health.setReadiness(readiness);

	// systemd (Type=notify): READY, WATCHDOG and STOPPING follow the health
	// object. Null, and nothing ever spawned, without NOTIFY_SOCKET. Created
	// before the engine so NOTIFY_SOCKET is gone from the environment before
	// any agent can inherit it.
	const notifier = createSystemdNotifier({ env: process.env, health, onLog: log });
	if (notifier) {
		notifier.start();
		log(
			'info',
			notifier.watchdogIntervalMs !== null
				? `systemd: notifications on, watchdog ping every ${notifier.watchdogIntervalMs / 1000}s while healthy`
				: 'systemd: notifications on (no watchdog configured)'
		);
	}

	const webhook = webhookTarget
		? createCueNotifyWebhook({ target: webhookTarget, onLog: log })
		: null;
	if (webhook) log('info', `Notify webhook: ${webhook.display}`);

	const engine = await createStandaloneCueEngine({
		...(webhook ? { onExternalNotification: (n) => webhook.send(n) } : {}),
		onLog: log,
		onLockLost: () => health.markLockLost(),
		onDrainPhase: (phase, message) => health.noteDrainPhase(phase, message),
	});

	// The status server binds BEFORE the engine starts, so a taken port fails
	// the command with nothing armed: no lock, no trigger, no inbox.
	let statusServer: CueStatusServerHandle | null = null;
	if (options.statusPort !== undefined) {
		const { startCueStatusServer, CueStatusPortInUseError, CUE_STATUS_HOST } =
			await import('../../main/cue/cue-status-server');
		try {
			statusServer = await startCueStatusServer({
				port: options.statusPort,
				health,
				engine,
			});
		} catch (err) {
			health.dispose();
			if (!(err instanceof CueStatusPortInUseError)) throw err;
			if (options.json) {
				console.log(
					JSON.stringify({ started: false, code: err.code, error: err.message, port: err.port })
				);
			} else {
				log('error', err.message);
			}
			process.exit(1);
		}
		setCueEngineLockStatusPort(statusServer.port);
		log('info', `Status server listening on http://${CUE_STATUS_HOST}:${statusServer.port}`);
	}
	const closeStatusServer = () => {
		health.dispose();
		const server = statusServer;
		statusServer = null;
		return server ? server.close() : Promise.resolve();
	};

	// First signal: drain (see CueEngine.drain). Second signal: stop every
	// run and kill every Cue process tree now. The process exits only once the
	// drain has resolved, i.e. with no agent process left running.
	let shuttingDown = false;
	let stopTriggerInbox: (() => void) | null = null;
	const drainTimeoutMs = (options.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT_SECONDS) * 1000;
	const shutdown = (signal: string) => {
		if (shuttingDown) {
			log('warn', `Received ${signal} again, stopping every run now...`);
			engine.forceStop();
			return;
		}
		shuttingDown = true;
		health.markDraining();
		stopTriggerInbox?.();
		log(
			'info',
			`Received ${signal}, draining (up to ${drainTimeoutMs / 1000}s; send it again to stop now)...`
		);
		void engine
			.drain({ timeoutMs: drainTimeoutMs })
			.then(async (report) => {
				health.markStopped();
				if (statusServer) setCueEngineLockStatusPort(undefined);
				await closeStatusServer();
				notifier?.stop();
				// The drain's last STATUS lines are still queued behind STOPPING, and
				// a notify run that finished during the drain may still be posting.
				await Promise.all([
					notifier?.flush(SYSTEMD_FLUSH_ON_EXIT_MS),
					webhook?.flush(SYSTEMD_FLUSH_ON_EXIT_MS),
				]);
				process.exit(report.forced ? 1 : 0);
			})
			.catch((err) => {
				log('error', `Drain failed: ${err instanceof Error ? err.message : String(err)}`);
				engine.forceStop();
				process.exit(1);
			});
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	engine.start('system-boot');

	// A lock conflict makes start() a silent no-op (see cue-engine.ts) -
	// surface that here as a real command failure rather than exiting 0
	// having done nothing, which the exit code below distinguishes.
	const lock = readCueEngineLock();
	const startedByUs = lock ? isCueEngineLockOwnedByThisProcess(lock) : false;

	if (!startedByUs) {
		const conflictMessage = lock
			? `Another Cue engine (${lock.mode}, pid ${lock.pid}, started ${lock.startedAt}) already holds the lock. Stop it first ("maestro-cli cue engine stop" if it's a standalone runner, or disable Cue in the desktop app's Settings).`
			: 'Engine failed to start (see the log line above for the reason).';
		if (options.json) {
			console.log(JSON.stringify({ started: false, error: conflictMessage }));
		} else {
			log('error', conflictMessage);
		}
		// The notifier reports STATUS=Stopped (no READY) and the unit fails.
		health.markStopped();
		notifier?.stop();
		if (statusServer) setCueEngineLockStatusPort(undefined);
		await closeStatusServer();
		process.exitCode = 1;
		return;
	}

	// `maestro-cli cue trigger` reaches this runner through the inbox, since
	// there is no desktop WebSocket to carry it (see cue-trigger-inbox.ts).
	stopTriggerInbox = startCueTriggerInbox((name, prompt, sourceAgentId) =>
		engine.triggerSubscription(name, prompt, sourceAgentId)
	);
	health.markRunning();

	if (options.json) {
		console.log(
			JSON.stringify({
				started: true,
				pid: process.pid,
				dataDir: dataDir.dir,
				ready: readiness.ready,
				gaps: readiness.gaps.length,
				...(statusServer ? { statusPort: statusServer.port } : {}),
			})
		);
	} else {
		const sessionCount = readSessions().length;
		log(
			'info',
			`Engine started (pid ${process.pid}). Watching ${sessionCount} agent(s) for .maestro/cue.yaml. Press Ctrl+C to stop.`
		);
	}

	// Block forever - the process stays alive on the SIGINT/SIGTERM
	// listeners above until shutdown() calls process.exit().
	await new Promise<void>(() => {});
}

export interface CueEngineCheckOptions {
	json?: boolean;
	dataDir?: string;
}

/**
 * The readiness check alone: what `cue engine start --require-ready` would
 * refuse on, without starting anything. Meant for right after `bundle import`.
 * Exit 0 when ready, 1 with every gap listed when not. Needs no SQLite.
 */
export async function cueEngineCheck(options: CueEngineCheckOptions = {}): Promise<void> {
	applyDataDirOption(options.dataDir);
	requireDataDirOrExit(options);
	const { formatCueReadiness } = await import('../../main/cue/cue-readiness');
	const report = await computeCueReadiness();
	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		for (const line of formatCueReadiness(report)) console.log(line);
	}
	if (!report.ready) process.exitCode = 1;
}

/**
 * Signal a running standalone engine to stop. Cannot stop a Cue engine
 * running INSIDE the desktop app - `readCueEngineLock()` reports its mode as
 * `'desktop'`, and this command refuses to signal that process (killing the
 * whole Maestro app to stop Cue would be a much bigger side effect than the
 * user asked for; use the desktop app's own Settings toggle instead).
 */
export async function cueEngineStop(options: CueEngineStopOptions = {}): Promise<void> {
	applyDataDirOption(options.dataDir);
	requireDataDirOrExit(options);
	const lock = readCueEngineLock();
	if (!lock) {
		const message = 'No Cue engine is currently running (lock file absent or stale).';
		if (options.json) console.log(JSON.stringify({ stopped: false, reason: 'not-running' }));
		else console.log(`[Cue] ${message}`);
		return;
	}
	if (lock.mode === 'desktop') {
		const message = `The running Cue engine is inside the desktop app (pid ${lock.pid}). Stop it from Settings -> Maestro Cue instead - this command only stops a standalone runner.`;
		if (options.json)
			console.log(JSON.stringify({ stopped: false, reason: 'desktop-owned', pid: lock.pid }));
		else console.error(`[Cue] ${message}`);
		process.exitCode = 1;
		return;
	}

	// A PID from another PID namespace (another container sharing this data
	// directory) names some unrelated process here, if anything - signaling it
	// could kill a stranger, so refuse rather than guess.
	if (isCueEngineLockInForeignPidNamespace(lock)) {
		const message =
			'The running Cue engine is in a different PID namespace. Cannot safely signal it by PID.';
		if (options.json)
			console.log(
				JSON.stringify({ stopped: false, reason: 'foreign-pid-namespace', pid: lock.pid })
			);
		else console.error(`[Cue] ${message}`);
		process.exitCode = 1;
		return;
	}

	try {
		process.kill(lock.pid, 'SIGTERM');
	} catch (err) {
		const message = `Could not signal pid ${lock.pid}: ${err instanceof Error ? err.message : String(err)}`;
		if (options.json) console.log(JSON.stringify({ stopped: false, reason: 'signal-failed' }));
		else console.error(`[Cue] ${message}`);
		process.exitCode = 1;
		return;
	}

	const waitMs = options.waitMs ?? 5000;
	const pollIntervalMs = 100;
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		if (!readCueEngineLock()) {
			if (options.json) console.log(JSON.stringify({ stopped: true, pid: lock.pid }));
			else console.log(`[Cue] Engine (pid ${lock.pid}) stopped.`);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
	}

	const message = `Sent SIGTERM to pid ${lock.pid} but the lock is still held after ${waitMs}ms - it may still be shutting down, or may need a manual kill.`;
	if (options.json)
		console.log(JSON.stringify({ stopped: false, reason: 'timeout', pid: lock.pid }));
	else console.warn(`[Cue] ${message}`);
	process.exitCode = 1;
}

interface CueEngineStatusPayload {
	running: boolean;
	mode?: 'desktop' | 'standalone';
	pid?: number;
	startedAt?: string;
	uptimeMs?: number;
	lastHeartbeatMs?: number | null;
	lastHeartbeatAgeMs?: number | null;
	totalEvents?: number;
	/** Loopback port of the runner's status server, when it runs one. */
	statusPort?: number;
}

async function buildStatusPayload(): Promise<CueEngineStatusPayload> {
	const lock = readCueEngineLock();
	if (!lock) return { running: false };

	// Read-only DB access for the status figures below - initCueDb() no-ops
	// if a db handle already exists in THIS process, and opening it here
	// never conflicts with the runner's own handle (SQLite/WAL supports
	// multiple readers).
	const { initCueDb, getLastHeartbeat, countCueEvents } = await import('../../main/cue/cue-db');
	initCueDb();
	const lastHeartbeatMs = getLastHeartbeat();

	return {
		running: true,
		mode: lock.mode,
		pid: lock.pid,
		startedAt: lock.startedAt,
		uptimeMs: Date.now() - Date.parse(lock.startedAt),
		lastHeartbeatMs,
		lastHeartbeatAgeMs: lastHeartbeatMs != null ? Date.now() - lastHeartbeatMs : null,
		totalEvents: countCueEvents(),
		...(lock.statusPort !== undefined ? { statusPort: lock.statusPort } : {}),
	};
}

export async function cueEngineStatus(options: CueEngineStatusOptions = {}): Promise<void> {
	applyDataDirOption(options.dataDir);
	requireDataDirOrExit(options);
	const payload = await statusPayloadOrReport(options);
	if (!payload) return;

	if (options.json) {
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	if (!payload.running) {
		console.log('[Cue] Not running (no live lock for this data directory).');
		return;
	}

	const lines = [
		`[Cue] Running: ${payload.mode} (pid ${payload.pid})`,
		`  Started: ${payload.startedAt} (${humanizeDuration(payload.uptimeMs ?? 0)} ago)`,
		payload.lastHeartbeatAgeMs != null
			? `  Last heartbeat: ${humanizeDuration(payload.lastHeartbeatAgeMs)} ago`
			: '  Last heartbeat: none yet',
		`  Total events recorded: ${payload.totalEvents ?? 0}`,
		payload.statusPort !== undefined
			? `  Status server: http://127.0.0.1:${payload.statusPort}/status`
			: '  Status server: not running (start with --status-port)',
	];
	console.log(lines.join('\n'));
}

interface CueEngineInspectAgentPayload {
	id: string;
	name: string;
	toolType: string;
	projectRoot: string;
	cueConfigured: boolean;
	subscriptionCount: number;
	enabledSubscriptionCount: number;
	configError?: string;
	/** Subscriptions the engine will skip, and why (invalid entries, unresolved prompt files). */
	warnings?: string[];
}

export interface CueEngineInspectOptions {
	json?: boolean;
	dataDir?: string;
}

/**
 * Enumerate every agent with a readable `.maestro/cue.yaml`, independent of
 * whether an engine is currently running - this is what "which agents WOULD
 * this runner watch" answers, complementing `status`'s "is it running".
 */
export async function cueEngineInspect(options: CueEngineInspectOptions = {}): Promise<void> {
	applyDataDirOption(options.dataDir);
	requireDataDirOrExit(options);
	const { loadCueConfigDetailed } = await import('../../main/cue/cue-yaml-loader');
	const sessions = readSessions();
	const agents: CueEngineInspectAgentPayload[] = [];

	for (const session of sessions) {
		const projectRoot = session.projectRoot || session.cwd || session.fullPath;
		if (!projectRoot) continue;
		const result = loadCueConfigDetailed(projectRoot);
		if (!result.ok) {
			if (result.reason === 'missing') continue;
			agents.push({
				id: session.id,
				name: session.name,
				toolType: session.toolType,
				projectRoot,
				cueConfigured: true,
				subscriptionCount: 0,
				enabledSubscriptionCount: 0,
				configError: result.reason === 'parse-error' ? result.message : result.errors.join('; '),
			});
			continue;
		}
		agents.push({
			id: session.id,
			name: session.name,
			toolType: session.toolType,
			projectRoot,
			cueConfigured: true,
			subscriptionCount: result.config.subscriptions.length,
			enabledSubscriptionCount: result.config.subscriptions.filter((s) => s.enabled !== false)
				.length,
			...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
		});
	}

	const status = await statusPayloadOrReport(options);
	if (!status) return;

	if (options.json) {
		console.log(JSON.stringify({ status, agents }, null, 2));
		return;
	}

	console.log(
		status.running
			? `[Cue] Engine running: ${status.mode} (pid ${status.pid})`
			: '[Cue] Engine not running.'
	);
	if (agents.length === 0) {
		console.log('No agents have a .maestro/cue.yaml configured.');
		return;
	}
	console.log(`\n${agents.length} agent(s) with Cue configured:\n`);
	for (const agent of agents) {
		const label = `${agent.name} (${getAgentDisplayName(agent.toolType)})`;
		if (agent.configError) {
			console.log(`  ✗ ${label} - config error: ${agent.configError}`);
			continue;
		}
		console.log(
			`  • ${label}: ${agent.enabledSubscriptionCount}/${agent.subscriptionCount} subscription(s) enabled`
		);
		// Without these, a subscription the engine drops for being invalid
		// simply vanishes from the count, and "0/0" gives no hint why.
		for (const warning of agent.warnings ?? []) {
			console.log(`      ! ${warning}`);
		}
	}
}
