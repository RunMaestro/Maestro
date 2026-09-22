/**
 * `maestro-cli cue-engine` - run Maestro Cue unattended, without the desktop
 * app, and inspect/control that runner.
 *
 * Unlike `cue schedule` / `cue trigger` / `cue list` (which either edit
 * `.maestro/cue.yaml` directly or talk to a RUNNING desktop app over
 * `withMaestroClient`), `start` boots a real `CueEngine` dispatch loop in
 * THIS process - see `src/cli/services/cue-standalone-engine.ts` for what
 * that engine can and cannot do relative to the desktop app's own instance.
 * `stop` / `status` / `inspect` talk to that runner ONLY through the
 * on-disk state it shares with the desktop app (the cross-process lock file,
 * `cue.db`) - there is no live RPC channel into a running standalone
 * process, so `status`/`inspect` report what was last PERSISTED (lock info,
 * DB heartbeat, recent history rows), not the runner's live in-memory
 * counters (active run count, queue depth). A future iteration could open a
 * small localhost status endpoint from the runner itself for that; today's
 * scope is what the shared files already answer.
 */

import { readCueEngineLock } from '../../main/cue/cue-engine-lock';
import { createStandaloneCueEngine } from '../services/cue-standalone-engine';
import { readSessions } from '../services/storage';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { humanizeDuration } from '../../shared/duration';

export interface CueEngineStartOptions {
	json?: boolean;
}

export interface CueEngineStopOptions {
	json?: boolean;
	/** Milliseconds to wait for the lock to clear after signaling before giving up. Mainly for tests. */
	waitMs?: number;
}

export interface CueEngineStatusOptions {
	json?: boolean;
}

/**
 * Start the standalone engine in THIS process and block until interrupted.
 * `CueEngine.start()` acquires the cross-process lock itself
 * (`cue-engine-lock.ts`) and simply no-ops (with a logged error) if another
 * live engine - desktop or standalone - already holds it, so a double-start
 * here is safe by construction, not by this command's own checking.
 */
export async function cueEngineStart(options: CueEngineStartOptions = {}): Promise<void> {
	const engine = await createStandaloneCueEngine();

	let shuttingDown = false;
	const shutdown = (signal: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`\n[Cue] Received ${signal}, stopping engine...`);
		engine.stop();
		// Give in-flight log lines a tick to flush before exiting - stop()
		// itself is synchronous, but downstream process kills (shell/cli
		// executors) it triggers are not guaranteed to have settled yet.
		setTimeout(() => process.exit(0), 250);
	};
	process.on('SIGINT', () => shutdown('SIGINT'));
	process.on('SIGTERM', () => shutdown('SIGTERM'));

	engine.start('system-boot');

	const status = engine.getStatus();
	// A lock conflict makes start() a silent no-op (see cue-engine.ts) -
	// surface that here as a real command failure rather than exiting 0
	// having done nothing, which the exit code below distinguishes.
	const lock = readCueEngineLock();
	const startedByUs = lock?.pid === process.pid;

	if (!startedByUs) {
		const conflictMessage = lock
			? `Another Cue engine (${lock.mode}, pid ${lock.pid}, started ${lock.startedAt}) already holds the lock. Stop it first ("maestro-cli cue-engine stop" if it's a standalone runner, or disable Cue in the desktop app's Settings).`
			: 'Engine failed to start (see the log line above for the reason).';
		if (options.json) {
			console.log(JSON.stringify({ started: false, error: conflictMessage }));
		} else {
			console.error(`[Cue] ${conflictMessage}`);
		}
		process.exitCode = 1;
		return;
	}

	if (options.json) {
		console.log(JSON.stringify({ started: true, pid: process.pid }));
	} else {
		const sessionCount = readSessions().length;
		console.log(
			`[Cue] Engine started (pid ${process.pid}). Watching ${sessionCount} agent(s) for .maestro/cue.yaml. Press Ctrl+C to stop.`
		);
	}
	void status;

	// Block forever - the process stays alive on the SIGINT/SIGTERM
	// listeners above until shutdown() calls process.exit().
	await new Promise<void>(() => {});
}

/**
 * Signal a running standalone engine to stop. Cannot stop a Cue engine
 * running INSIDE the desktop app - `readCueEngineLock()` reports its mode as
 * `'desktop'`, and this command refuses to signal that process (killing the
 * whole Maestro app to stop Cue would be a much bigger side effect than the
 * user asked for; use the desktop app's own Settings toggle instead).
 */
export async function cueEngineStop(options: CueEngineStopOptions = {}): Promise<void> {
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
	if (options.json) console.log(JSON.stringify({ stopped: false, reason: 'timeout', pid: lock.pid }));
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
	};
}

export async function cueEngineStatus(options: CueEngineStatusOptions = {}): Promise<void> {
	const payload = await buildStatusPayload();

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
}

export interface CueEngineInspectOptions {
	json?: boolean;
}

/**
 * Enumerate every agent with a readable `.maestro/cue.yaml`, independent of
 * whether an engine is currently running - this is what "which agents WOULD
 * this runner watch" answers, complementing `status`'s "is it running".
 */
export async function cueEngineInspect(options: CueEngineInspectOptions = {}): Promise<void> {
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
		});
	}

	const status = await buildStatusPayload();

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
	}
}
