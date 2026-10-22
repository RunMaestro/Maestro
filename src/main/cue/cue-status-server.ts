/**
 * Loopback HTTP status server for a headless Cue engine
 * (`maestro-cli cue engine start --status-port <port>`).
 *
 * Three read-only endpoints, so Docker, systemd and monitoring can ask a
 * running engine whether it is alive and ready:
 *
 * - `/healthz`: liveness. 200 unless the lock was lost or the event loop is
 *   saturated (`evaluateLiveness` in `cue-engine-health.ts`).
 * - `/readyz`: readiness. 200 only while running with no readiness gaps
 *   (`evaluateReadiness`); the 503 body names the gaps.
 * - `/status`: a JSON snapshot of the engine.
 *
 * Deliberately separate from the webhook listener (`cue-webhook-server.ts`):
 * different port, different lifetime (this one lives exactly as long as the
 * command), and it binds 127.0.0.1 with no override, because nothing here is
 * authenticated. Nothing it returns carries a secret value, a prompt, run
 * output or an event payload: every field is picked explicitly rather than
 * spread from an engine object, so a field added to one of those later cannot
 * leak by accident.
 *
 * Cheap by construction: no request body is read, no file is read per
 * request, and the readiness re-check is cached (see `ensureFreshReadiness`).
 * No Electron imports.
 */

import * as http from 'http';
import type { CueGraphSession, CueRunResult, CueSessionStatus } from '../../shared/cue/contracts';
import type { CueReadinessGap, CueReadinessReport } from './cue-readiness';
import { evaluateLiveness, evaluateReadiness, type CueEngineHealth } from './cue-engine-health';

/** The documented status port (the Docker HEALTHCHECK and systemd unit use it). */
export const DEFAULT_CUE_STATUS_PORT = 7433;
/** The only bind address. Not configurable: the endpoints are unauthenticated. */
export const CUE_STATUS_HOST = '127.0.0.1';
/** Active runs listed individually in `/status`; the count covers all of them. */
export const CUE_STATUS_MAX_LISTED_RUNS = 20;

const STATUS_PATHS = new Set(['/healthz', '/readyz', '/status']);
const REQUEST_TIMEOUT_MS = 5_000;

/** What the server reads from the engine: its public query API, nothing else. */
export interface CueStatusEngineView {
	getActiveRuns(): CueRunResult[];
	getQueueStatus(): Map<string, number>;
	getStatus(): CueSessionStatus[];
	getGraphData(): CueGraphSession[];
}

export interface CueStatusServerOptions {
	port: number;
	health: CueEngineHealth;
	engine: CueStatusEngineView;
}

export interface CueStatusServerHandle {
	/** The bound port (the requested one, or the OS pick when 0 was requested). */
	port: number;
	close(): Promise<void>;
}

/** A status port that is already taken. The command turns it into one line and exit 1. */
export class CueStatusPortInUseError extends Error {
	readonly code = 'STATUS_PORT_IN_USE';
	constructor(readonly port: number) {
		super(
			`Status port ${port} on ${CUE_STATUS_HOST} is already in use. Pick a free one with --status-port.`
		);
		this.name = 'CueStatusPortInUseError';
	}
}

/** Gap fields safe to publish: names, paths and the actionable message. Never spread a gap. */
function publicGap(gap: CueReadinessGap) {
	return {
		kind: gap.kind,
		message: gap.message,
		...(gap.agentId ? { agentId: gap.agentId } : {}),
		...(gap.agentName ? { agentName: gap.agentName } : {}),
		...(gap.subscription ? { subscription: gap.subscription } : {}),
		...(gap.workspace ? { workspace: gap.workspace } : {}),
		...(gap.secret ? { secret: gap.secret } : {}),
		...(gap.tool ? { tool: gap.tool } : {}),
	};
}

function publicReadiness(report: CueReadinessReport | null) {
	if (!report) return null;
	return {
		ready: report.ready,
		checkedAt: report.checkedAt,
		agents: report.agents,
		workspaces: report.workspaces,
		subscriptions: report.subscriptions,
		gaps: report.gaps.map(publicGap),
	};
}

export function buildHealthzBody(health: CueEngineHealth) {
	const verdict = evaluateLiveness(health);
	return {
		code: verdict.ok ? 200 : 503,
		body: { status: verdict.ok ? 'ok' : 'fail', phase: health.phase(), reasons: verdict.reasons },
	};
}

export function buildReadyzBody(health: CueEngineHealth) {
	const verdict = evaluateReadiness(health);
	const report = health.readiness();
	return {
		code: verdict.ok ? 200 : 503,
		body: {
			ready: verdict.ok,
			phase: health.phase(),
			reasons: verdict.reasons,
			checkedAt: report?.checkedAt ?? null,
			gaps: report ? report.gaps.map(publicGap) : [],
		},
	};
}

/**
 * Subscriptions by trigger type, enabled ones only. `getGraphData()` lists a
 * fan-out subscription under every participating agent, so one subscription
 * is counted once per (name, event type).
 */
function countSubscriptions(graph: CueGraphSession[]) {
	const seen = new Set<string>();
	const byTrigger: Record<string, number> = {};
	for (const session of graph) {
		for (const sub of session.subscriptions) {
			if (sub.enabled === false) continue;
			const key = `${sub.name}\u0000${sub.event}`;
			if (seen.has(key)) continue;
			seen.add(key);
			byTrigger[sub.event] = (byTrigger[sub.event] ?? 0) + 1;
		}
	}
	return { total: seen.size, byTrigger };
}

export function buildStatusBody(health: CueEngineHealth, engine: CueStatusEngineView) {
	const now = health.now();
	const sessions = engine.getStatus();
	const names = new Map(sessions.map((s) => [s.sessionId, s.sessionName]));
	const runs = engine.getActiveRuns();
	const memory = process.memoryUsage();
	return {
		phase: health.phase(),
		pid: health.pid,
		version: health.version,
		dataDir: health.dataDir,
		startedAt: new Date(health.startedAt).toISOString(),
		uptimeMs: now - health.startedAt,
		activeRuns: {
			count: runs.length,
			runs: runs.slice(0, CUE_STATUS_MAX_LISTED_RUNS).map((run) => ({
				runId: run.runId,
				subscriptionName: run.subscriptionName,
				agentId: run.sessionId,
				agentName: run.sessionName,
				eventType: run.event?.type,
				startedAt: run.startedAt,
			})),
		},
		queue: [...engine.getQueueStatus()].map(([agentId, depth]) => ({
			agentId,
			agentName: names.get(agentId) ?? null,
			depth,
		})),
		agents: { total: sessions.length, enabled: sessions.filter((s) => s.enabled).length },
		subscriptions: countSubscriptions(engine.getGraphData()),
		readiness: publicReadiness(health.readiness()),
		memory: {
			rssBytes: memory.rss,
			heapUsedBytes: memory.heapUsed,
			heapTotalBytes: memory.heapTotal,
		},
		eventLoopDelayMs: health.eventLoopDelay(),
	};
}

function send(
	res: http.ServerResponse,
	head: boolean,
	code: number,
	body: unknown,
	headers: Record<string, string> = {}
): void {
	const json = JSON.stringify(body);
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(json),
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(head ? undefined : json);
}

async function handle(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	options: CueStatusServerOptions
): Promise<void> {
	// Never read a body; discard whatever was sent so the socket can be reused.
	req.resume();
	const path = (req.url ?? '/').split('?')[0];
	const method = req.method ?? 'GET';
	const head = method === 'HEAD';
	if (!STATUS_PATHS.has(path)) {
		send(res, head, 404, { error: 'Not found' });
		return;
	}
	if (method !== 'GET' && !head) {
		send(res, false, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
		return;
	}
	const { health, engine } = options;
	if (path === '/healthz') {
		const { code, body } = buildHealthzBody(health);
		send(res, head, code, body);
		return;
	}
	await health.ensureFreshReadiness();
	if (path === '/readyz') {
		const { code, body } = buildReadyzBody(health);
		send(res, head, code, body);
		return;
	}
	send(res, head, 200, buildStatusBody(health, engine));
}

/**
 * Bind the status server on 127.0.0.1. Resolves once listening; rejects with
 * {@link CueStatusPortInUseError} when the port is taken, before the caller
 * has armed anything.
 */
export function startCueStatusServer(
	options: CueStatusServerOptions
): Promise<CueStatusServerHandle> {
	const server = http.createServer((req, res) => {
		handle(req, res, options).catch(() => {
			// A bug in our own handler, not a bad request: answer rather than hang.
			if (!res.headersSent) {
				// No error detail: a message can quote whatever the failing step held.
				send(res, false, 500, { error: 'Internal error' });
			} else {
				res.destroy();
			}
		});
	});
	server.requestTimeout = REQUEST_TIMEOUT_MS;
	server.headersTimeout = REQUEST_TIMEOUT_MS;
	server.keepAliveTimeout = 1_000;
	server.maxHeadersCount = 50;

	return new Promise((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException) => {
			server.removeListener('listening', onListening);
			reject(err.code === 'EADDRINUSE' ? new CueStatusPortInUseError(options.port) : err);
		};
		const onListening = () => {
			server.removeListener('error', onError);
			const address = server.address();
			const port = address && typeof address === 'object' ? address.port : options.port;
			resolve({
				port,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => done());
						server.closeAllConnections?.();
					}),
			});
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(options.port, CUE_STATUS_HOST);
	});
}
