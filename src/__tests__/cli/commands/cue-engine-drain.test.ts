/**
 * `cue engine start` shutdown: the first SIGTERM/SIGINT drains (status server
 * reports draining, /readyz 503, the trigger inbox closes, exit 0 once the
 * drain resolves); a second signal forces it (exit 1). `--drain-timeout`
 * reaches the drain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { parseCliSeconds } from '../../../cli/utils/parse';

vi.mock('better-sqlite3', () => ({
	default: class {
		close() {}
	},
}));
vi.mock('../../../main/cue/cue-readiness', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/cue-readiness')>()),
	checkCueReadiness: vi.fn(async () => ({
		ready: true,
		checkedAt: '2026-10-06T12:00:00.000Z',
		agents: 0,
		workspaces: 0,
		subscriptions: 0,
		gaps: [],
	})),
}));

const drainControl = vi.hoisted(() => ({
	resolve: (_forced: boolean) => {},
}));
const engine = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	getStatus: vi.fn(() => []),
	getActiveRuns: vi.fn(() => []),
	getQueueStatus: vi.fn(() => new Map()),
	getGraphData: vi.fn(() => []),
	triggerSubscription: vi.fn(),
	drain: vi.fn(
		() =>
			new Promise((resolve) => {
				drainControl.resolve = (forced: boolean) =>
					resolve({
						forced,
						completed: 0,
						stopped: 0,
						persistedQueue: 0,
						partialFanIns: 0,
						durationMs: 0,
					});
			})
	),
	forceStop: vi.fn(() => drainControl.resolve(true)),
}));
vi.mock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
	createStandaloneCueEngine: vi.fn(async () => engine),
}));
const inbox = vi.hoisted(() => ({ stop: vi.fn() }));
vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	startCueTriggerInbox: vi.fn(() => inbox.stop),
}));
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() => ({
		pid: process.pid,
		mode: 'standalone',
		startedAt: new Date().toISOString(),
	})),
	isCueEngineLockOwnedByThisProcess: vi.fn(() => true),
	isCueEngineLockInForeignPidNamespace: vi.fn(() => false),
	setCueEngineLockStatusPort: vi.fn(),
}));

import { startCueTriggerInbox } from '../../../cli/services/cue-trigger-inbox';
import { cueEngineStart, DEFAULT_DRAIN_TIMEOUT_SECONDS } from '../../../cli/commands/cue-engine';

async function freePort(): Promise<number> {
	const server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

let tmp: string;
let savedUserData: string | undefined;
let added: { SIGINT: Function[]; SIGTERM: Function[] };
let exits: number[];

function newListeners(sig: 'SIGINT' | 'SIGTERM'): Array<(s: string) => void> {
	return process.listeners(sig).filter((l) => !added[sig].includes(l)) as Array<
		(s: string) => void
	>;
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-engine-drain-')));
	fs.writeFileSync(path.join(tmp, 'maestro-sessions.json'), '{"sessions":[]}');
	savedUserData = process.env.MAESTRO_USER_DATA;
	vi.clearAllMocks();
	added = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
	exits = [];
	vi.spyOn(console, 'log').mockImplementation(() => {});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'warn').mockImplementation(() => {});
	vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
		exits.push(code);
	}) as never);
});

afterEach(async () => {
	drainControl.resolve(false);
	await new Promise((resolve) => setTimeout(resolve, 20));
	for (const sig of ['SIGINT', 'SIGTERM'] as const) {
		for (const listener of newListeners(sig)) process.removeListener(sig, listener);
	}
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function startEngine(extra: Record<string, unknown> = {}) {
	const port = await freePort();
	void cueEngineStart({ dataDir: tmp, statusPort: port, ...extra });
	await vi.waitFor(() => expect(startCueTriggerInbox).toHaveBeenCalled());
	return `http://127.0.0.1:${port}`;
}

describe('cue engine start shutdown', () => {
	it('first signal drains: /readyz 503 while draining, inbox closed, exit 0', async () => {
		const base = await startEngine({ drainTimeout: 12 });
		expect((await fetch(`${base}/readyz`)).status).toBe(200);

		newListeners('SIGTERM')[0]('SIGTERM');
		expect(engine.drain).toHaveBeenCalledWith({ timeoutMs: 12_000 });
		expect(inbox.stop).toHaveBeenCalled();
		const readyz = await fetch(`${base}/readyz`);
		expect(readyz.status).toBe(503);
		expect((await readyz.json()).phase).toBe('draining');
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect(exits).toEqual([]);

		drainControl.resolve(false);
		await vi.waitFor(() => expect(exits).toEqual([0]));
		await expect(fetch(`${base}/healthz`)).rejects.toThrow();
	});

	it('second signal forces the stop and exits 1', async () => {
		await startEngine();
		newListeners('SIGTERM')[0]('SIGTERM');
		expect(engine.drain).toHaveBeenCalledWith({ timeoutMs: DEFAULT_DRAIN_TIMEOUT_SECONDS * 1000 });
		newListeners('SIGINT')[0]('SIGINT');
		expect(engine.forceStop).toHaveBeenCalledTimes(1);
		await vi.waitFor(() => expect(exits).toEqual([1]));
	});
});

describe('--drain-timeout parsing', () => {
	it('accepts whole seconds, 0 included', () => {
		expect(parseCliSeconds('0', '--drain-timeout')).toBe(0);
		expect(parseCliSeconds(' 90 ', '--drain-timeout')).toBe(90);
	});

	it('rejects anything else, naming the flag', () => {
		for (const bad of ['-1', '1.5', 'abc', '', '9e9999']) {
			expect(() => parseCliSeconds(bad, '--drain-timeout')).toThrow(/--drain-timeout/);
		}
	});
});
