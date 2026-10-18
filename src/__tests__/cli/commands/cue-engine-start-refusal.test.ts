/**
 * `cue engine start` refused by a lock another engine holds: the message says
 * what is known about the holder (a different running process, this process's
 * own pid left by an engine that is gone, or another PID namespace), and
 * `--json` keeps `started` and `error` and adds a `holder` object.
 *
 * The engine is stubbed to never take the lock, so the command reads the lock
 * file this test wrote, through the real lock module.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';

// cue.db's native module is built for Electron in a checkout; the probe only
// needs it to load.
vi.mock('better-sqlite3', () => ({
	default: class {
		close() {}
	},
}));

vi.mock('../../../main/cue/cue-readiness', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/cue-readiness')>()),
	checkCueReadiness: vi.fn(async () => ({
		ready: true,
		checkedAt: '2026-10-15T12:00:00.000Z',
		agents: 0,
		workspaces: 0,
		subscriptions: 0,
		gaps: [],
	})),
}));

const engine = vi.hoisted(() => ({
	start: vi.fn(),
	stop: vi.fn(),
	getStatus: vi.fn(() => ({})),
	triggerSubscription: vi.fn(),
}));
vi.mock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
	createStandaloneCueEngine: vi.fn(async () => engine),
}));
vi.mock('../../../cli/services/cue-trigger-inbox', () => ({
	startCueTriggerInbox: vi.fn(() => () => {}),
}));

import { cueEngineStart } from '../../../cli/commands/cue-engine';

/** This process's PID namespace inode, read the same way the lock module reads it. */
function currentPidNsInode(): number | undefined {
	if (process.platform !== 'linux') return undefined;
	try {
		return fs.statSync('/proc/self/ns/pid').ino;
	} catch {
		return undefined;
	}
}

let tmp: string;
let savedUserData: string | undefined;
let spies: MockInstance[];

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-engine-refusal-')));
	fs.writeFileSync(path.join(tmp, 'maestro-sessions.json'), '{"sessions":[]}');
	savedUserData = process.env.MAESTRO_USER_DATA;
	spies = [
		vi.spyOn(console, 'log').mockImplementation(() => {}),
		vi.spyOn(console, 'error').mockImplementation(() => {}),
		vi.spyOn(console, 'warn').mockImplementation(() => {}),
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
	];
	vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
	process.exitCode = undefined;
});

function everythingPrinted(): string {
	return spies
		.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
		.join('\n');
}

/** The one JSON line the refusal printed. */
function refusalJson(): Record<string, unknown> {
	const line = everythingPrinted()
		.split('\n')
		.find((l) => l.includes('"started":false'));
	expect(line).toBeDefined();
	return JSON.parse(line!.slice(line!.indexOf('{')));
}

function writeLock(fields: Record<string, unknown>): void {
	const now = new Date().toISOString();
	fs.writeFileSync(
		path.join(tmp, 'cue-engine.lock'),
		JSON.stringify({ mode: 'standalone', startedAt: now, heartbeatAt: now, ...fields })
	);
}

describe('cue engine start refused by a held lock', () => {
	it('names a different running process and how to stop it', async () => {
		const child: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
		try {
			await new Promise((resolve) => child.once('spawn', resolve));
			writeLock({ pid: child.pid, token: 'other-engine' });

			await cueEngineStart({ dataDir: tmp });

			expect(process.exitCode).toBe(1);
			const printed = everythingPrinted();
			expect(printed).toContain(`pid ${child.pid} is a different process that is still running`);
			expect(printed).toContain('maestro-cli cue engine stop');
		} finally {
			child.kill();
		}
	});

	// Off Linux, or without /proc, the namespace cannot be proven, so a lock
	// naming our own pid is not taken at once: the message says why it waits.
	it('says the recorded pid is our own and when the lock frees', async () => {
		writeLock({ pid: process.pid, token: 'previous-engine' });

		await cueEngineStart({ dataDir: tmp, json: true });

		expect(process.exitCode).toBe(1);
		const json = refusalJson();
		expect(json.started).toBe(false);
		expect(String(json.error)).toContain("which is this process's own pid");
		expect(String(json.error)).toContain('frees when its heartbeat goes stale');
		expect(json.holder).toMatchObject({
			pid: process.pid,
			mode: 'standalone',
			relation: 'own-pid',
		});
		expect((json.holder as { staleInMs: number }).staleInMs).toBeGreaterThan(0);
	});

	it('says a lock from another PID namespace is judged by its heartbeat', async () => {
		writeLock({ pid: 1, token: 'other-container', pidNsInode: (currentPidNsInode() ?? 0) + 1 });

		await cueEngineStart({ dataDir: tmp, json: true });

		const json = refusalJson();
		expect(json.started).toBe(false);
		expect(String(json.error)).toContain('in another PID namespace');
		expect(json.holder).toMatchObject({ pid: 1, relation: 'foreign-pid-namespace' });
	});
});
