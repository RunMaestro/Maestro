/**
 * `cue engine start --status-port`: nothing listens without the flag; a taken
 * port fails the command before the engine starts (no lock, trigger or inbox);
 * a successful start serves the endpoints, flips /readyz to ready once running,
 * reports the port, and flips /healthz to 503 when the engine loses its lock.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { CueReadinessReport } from '../../../main/cue/cue-readiness';

vi.mock('better-sqlite3', () => ({
	default: class {
		close() {}
	},
}));

const report = vi.hoisted(() => ({ current: undefined as unknown }));
// A test that sets no report gets the real check over its data dir.
vi.mock('../../../main/cue/cue-readiness', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../main/cue/cue-readiness')>();
	return {
		...actual,
		checkCueReadiness: vi.fn(
			async (inputs: Parameters<typeof actual.checkCueReadiness>[0]) =>
				report.current ?? actual.checkCueReadiness(inputs)
		),
	};
});

const engine = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	getStatus: vi.fn(() => []),
	getActiveRuns: vi.fn(() => []),
	getQueueStatus: vi.fn(() => new Map()),
	getGraphData: vi.fn(() => []),
	triggerSubscription: vi.fn(),
	drain: vi.fn(async () => ({
		forced: false,
		completed: 0,
		stopped: 0,
		persistedQueue: 0,
		partialFanIns: 0,
		durationMs: 0,
	})),
	forceStop: vi.fn(),
}));
vi.mock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
	createStandaloneCueEngine: vi.fn(async () => engine),
}));
vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	startCueTriggerInbox: vi.fn(() => () => {}),
}));
const lock = vi.hoisted(() => ({ owned: true, statusPort: undefined as number | undefined }));
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() =>
		lock.owned
			? {
					pid: process.pid,
					mode: 'standalone',
					startedAt: new Date().toISOString(),
					statusPort: lock.statusPort,
				}
			: null
	),
	isCueEngineLockOwnedByThisProcess: vi.fn(() => lock.owned),
	isCueEngineLockInForeignPidNamespace: vi.fn(() => false),
	setCueEngineLockStatusPort: vi.fn(),
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	countCueEvents: vi.fn(() => 0),
}));

import { createStandaloneCueEngine } from '../../../cli/services/cue-standalone-engine';
import { startCueTriggerInbox } from '../../../cli/services/cue-trigger-inbox';
import { setCueEngineLockStatusPort } from '../../../main/cue/cue-engine-lock';
import { cueEngineCheck, cueEngineStart, cueEngineStatus } from '../../../cli/commands/cue-engine';

const ready: CueReadinessReport = {
	ready: true,
	checkedAt: '2026-10-06T12:00:00.000Z',
	agents: 1,
	workspaces: 1,
	subscriptions: 1,
	gaps: [],
};

/** A free loopback port: bind 0, read it, release it. */
async function freePort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

let tmp: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let throwOnExit = true;
let signalListeners: { SIGINT: Function[]; SIGTERM: Function[] };

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-engine-status-port-')));
	fs.writeFileSync(path.join(tmp, 'maestro-sessions.json'), '{"sessions":[]}');
	savedUserData = process.env.MAESTRO_USER_DATA;
	report.current = ready;
	lock.owned = true;
	lock.statusPort = undefined;
	throwOnExit = true;
	vi.clearAllMocks();
	signalListeners = {
		SIGINT: process.listeners('SIGINT'),
		SIGTERM: process.listeners('SIGTERM'),
	};
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	vi.spyOn(process, 'exit').mockImplementation((() => {
		if (throwOnExit) throw new Error('__exit__');
	}) as never);
});

afterEach(async () => {
	// Shut down whatever a start left listening (the status server), then drop
	// the signal listeners it registered.
	throwOnExit = false;
	for (const sig of ['SIGTERM', 'SIGINT'] as const) {
		for (const listener of process.listeners(sig)) {
			if (signalListeners[sig].includes(listener)) continue;
			(listener as (s: string) => void)(sig);
			process.removeListener(sig, listener as () => void);
		}
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
	process.exitCode = undefined;
});

describe('cue engine start --status-port', () => {
	it('listens on nothing without the flag', async () => {
		void cueEngineStart({ dataDir: tmp });
		await vi.waitFor(() => expect(engine.start).toHaveBeenCalled());
		expect(setCueEngineLockStatusPort).not.toHaveBeenCalled();
	});

	it('serves the endpoints, reports the port, and becomes ready once running', async () => {
		const port = await freePort();
		void cueEngineStart({ dataDir: tmp, statusPort: port, json: true, version: '1.2.3' });
		await vi.waitFor(() => expect(startCueTriggerInbox).toHaveBeenCalled());
		expect(setCueEngineLockStatusPort).toHaveBeenCalledWith(port);
		// The port is recorded before the engine (and so the lock) starts.
		expect(vi.mocked(setCueEngineLockStatusPort).mock.invocationCallOrder[0]).toBeLessThan(
			engine.start.mock.invocationCallOrder[0]
		);
		const result = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
		expect(result).toMatchObject({ started: true, statusPort: port });

		const base = `http://127.0.0.1:${port}`;
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		const readyz = await fetch(`${base}/readyz`);
		expect(readyz.status).toBe(200);
		const status = await (await fetch(`${base}/status`)).json();
		expect(status).toMatchObject({ phase: 'running', version: '1.2.3', dataDir: tmp });
	});

	it('reports readiness gaps on /readyz while /healthz stays 200', async () => {
		report.current = {
			...ready,
			ready: false,
			gaps: [{ kind: 'tool-missing', tool: 'gh', message: 'gh is not installed.' }],
		};
		const port = await freePort();
		void cueEngineStart({ dataDir: tmp, statusPort: port });
		await vi.waitFor(() => expect(startCueTriggerInbox).toHaveBeenCalled());
		const base = `http://127.0.0.1:${port}`;
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		const readyz = await fetch(`${base}/readyz`);
		expect(readyz.status).toBe(503);
		expect((await readyz.json()).gaps[0]).toMatchObject({ kind: 'tool-missing', tool: 'gh' });
	});

	it('agrees with check and --require-ready that an empty data dir is not ready', async () => {
		report.current = undefined; // the real check, over a data dir with no agents

		await cueEngineCheck({ dataDir: tmp, json: true });
		expect(process.exitCode).toBe(1);
		const checked = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(checked.gaps.map((g: { kind: string }) => g.kind)).toEqual(['nothing-to-run']);
		process.exitCode = undefined;

		await expect(cueEngineStart({ dataDir: tmp, requireReady: true, json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
			started: false,
			code: 'NOT_READY',
			readiness: { ready: false, gaps: [{ kind: 'nothing-to-run' }] },
		});

		const port = await freePort();
		void cueEngineStart({ dataDir: tmp, statusPort: port });
		await vi.waitFor(() => expect(startCueTriggerInbox).toHaveBeenCalled());
		const readyz = await fetch(`http://127.0.0.1:${port}/readyz`);
		expect(readyz.status).toBe(503);
		expect((await readyz.json()).gaps).toEqual([
			expect.objectContaining({ kind: 'nothing-to-run' }),
		]);
	});

	it('fails /healthz once the engine reports a lost lock', async () => {
		const port = await freePort();
		void cueEngineStart({ dataDir: tmp, statusPort: port });
		await vi.waitFor(() => expect(startCueTriggerInbox).toHaveBeenCalled());
		const options = vi.mocked(createStandaloneCueEngine).mock.calls[0][0];
		options?.onLockLost?.();
		const res = await fetch(`http://127.0.0.1:${port}/healthz`);
		expect(res.status).toBe(503);
		expect((await res.json()).phase).toBe('lock-lost');
		expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
	});

	it('exits 1 with one message on a taken port, before anything is armed', async () => {
		const blocker = http.createServer();
		await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
		const port = (blocker.address() as { port: number }).port;
		try {
			await expect(cueEngineStart({ dataDir: tmp, statusPort: port, json: true })).rejects.toThrow(
				'__exit__'
			);
			expect(process.exit).toHaveBeenCalledWith(1);
			expect(engine.start).not.toHaveBeenCalled();
			expect(startCueTriggerInbox).not.toHaveBeenCalled();
			expect(setCueEngineLockStatusPort).not.toHaveBeenCalled();
			expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toMatchObject({
				started: false,
				code: 'STATUS_PORT_IN_USE',
				port,
			});
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it('closes the status server when another engine holds the lock', async () => {
		lock.owned = false;
		const port = await freePort();
		await cueEngineStart({ dataDir: tmp, statusPort: port });
		expect(process.exitCode).toBe(1);
		expect(setCueEngineLockStatusPort).toHaveBeenLastCalledWith(undefined);
		await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
	});
});

describe('cue engine status', () => {
	it('reports the status port recorded in the lock', async () => {
		lock.statusPort = 7433;
		await cueEngineStatus({ dataDir: tmp, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			running: true,
			statusPort: 7433,
		});
		logSpy.mockClear();
		await cueEngineStatus({ dataDir: tmp });
		expect(String(logSpy.mock.calls[0][0])).toContain(
			'Status server: http://127.0.0.1:7433/status'
		);
	});

	it('says when the runner has no status server', async () => {
		await cueEngineStatus({ dataDir: tmp, json: true });
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).not.toHaveProperty('statusPort');
		logSpy.mockClear();
		await cueEngineStatus({ dataDir: tmp });
		expect(String(logSpy.mock.calls[0][0])).toContain('Status server: not running');
	});
});

describe('cue engine start --notify-webhook', () => {
	it('refuses a non-http(s) URL before anything starts, without echoing it', async () => {
		const bad = 'ftp://hook-user:hook-pass@hooks.example.com/in?token=s3cr3t-token';
		await expect(cueEngineStart({ dataDir: tmp, notifyWebhook: bad, json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(process.exit).toHaveBeenCalledWith(2);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		const printed = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
		expect(JSON.parse(printed)).toMatchObject({ started: false, code: 'INVALID_OPTIONS' });
		expect(printed).not.toContain('s3cr3t-token');
		expect(printed).not.toContain('hook-pass');
	});

	it('logs only origin and path for a good one', async () => {
		const stderr = vi.mocked(process.stderr.write);
		void cueEngineStart({
			dataDir: tmp,
			notifyWebhook: 'https://hook-user:hook-pass@hooks.example.com/in?token=s3cr3t-token',
		});
		await vi.waitFor(() => expect(startCueTriggerInbox).toHaveBeenCalled());
		const text = [...logSpy.mock.calls, ...stderr.mock.calls].map((c) => String(c[0])).join('\n');
		expect(text).toContain('Notify webhook: https://hooks.example.com/in');
		expect(text).not.toContain('s3cr3t-token');
		expect(text).not.toContain('hook-pass');
	});
});
