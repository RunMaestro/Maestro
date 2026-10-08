/**
 * `cue engine start --require-ready` refuses before anything is armed: no
 * engine is built (so no lock is taken and no trigger, webhook listener or
 * timer starts) and no trigger inbox opens. Without the flag the gaps are
 * logged and the engine starts as before. `cue engine check` is the same
 * report without starting.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CueReadinessReport } from '../../../main/cue/cue-readiness';

// cue.db's native module is built for Electron in a checkout; the probe only
// needs it to load.
vi.mock('better-sqlite3', () => ({
	default: class {
		close() {}
	},
}));

const report = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../../../main/cue/cue-readiness', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/cue-readiness')>()),
	checkCueReadiness: vi.fn(async () => report.current),
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
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	readCueEngineLock: vi.fn(() => null),
	isCueEngineLockOwnedByThisProcess: vi.fn(() => false),
	isCueEngineLockInForeignPidNamespace: vi.fn(() => false),
}));

import { createStandaloneCueEngine } from '../../../cli/services/cue-standalone-engine';
import { startCueTriggerInbox } from '../../../cli/services/cue-trigger-inbox';
import { cueEngineCheck, cueEngineStart } from '../../../cli/commands/cue-engine';

const SENTINEL = 'sentinel-cli-ready-do-not-leak';

const notReady: CueReadinessReport = {
	ready: false,
	checkedAt: '2026-10-06T12:00:00.000Z',
	agents: 2,
	workspaces: 1,
	subscriptions: 3,
	gaps: [
		{
			kind: 'binary-missing',
			agentId: 'a-coder',
			agentName: 'Coder',
			message: 'Agent "Coder": Claude Code was not found at /opt/missing/claude.',
		},
		{
			kind: 'secret-missing',
			agentId: 'a-coder',
			agentName: 'Coder',
			secret: 'DEPLOY_TOKEN',
			message: 'Agent "Coder" requires secret DEPLOY_TOKEN, which is not set.',
		},
		{
			kind: 'tool-missing',
			tool: 'gh',
			subscription: 'pr-review',
			message: 'GitHub trigger "pr-review" needs the GitHub CLI (gh), which is not installed.',
		},
	],
};

let tmp: string;
let savedUserData: string | undefined;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let stderrSpy: MockInstance;
let warnSpy: MockInstance;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-engine-ready-')));
	fs.writeFileSync(path.join(tmp, 'maestro-sessions.json'), '{"sessions":[]}');
	savedUserData = process.env.MAESTRO_USER_DATA;
	process.env.DEPLOY_TOKEN = SENTINEL;
	report.current = notReady;
	vi.mocked(createStandaloneCueEngine).mockClear();
	vi.mocked(startCueTriggerInbox).mockClear();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
	stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.DEPLOY_TOKEN;
	if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = savedUserData;
	fs.rmSync(tmp, { recursive: true, force: true });
	process.exitCode = undefined;
});

function everythingPrinted(): string {
	return [logSpy, errorSpy, warnSpy, stderrSpy]
		.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
		.join('\n');
}

describe('cue engine start --require-ready with gaps', () => {
	it('lists every gap, exits 1, and arms nothing', async () => {
		await expect(cueEngineStart({ dataDir: tmp, requireReady: true })).rejects.toThrow('__exit__');
		expect(process.exit).toHaveBeenCalledWith(1);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		expect(startCueTriggerInbox).not.toHaveBeenCalled();
		expect(engine.start).not.toHaveBeenCalled();
		const printed = everythingPrinted();
		for (const gap of notReady.gaps) expect(printed).toContain(gap.message);
		expect(printed).toContain('Not ready: 3 gap(s).');
		expect(fs.readdirSync(tmp)).toEqual(['maestro-sessions.json']);
	});

	it('prints the report as the one stdout object under --json', async () => {
		await expect(cueEngineStart({ dataDir: tmp, requireReady: true, json: true })).rejects.toThrow(
			'__exit__'
		);
		expect(logSpy).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			started: false,
			code: 'NOT_READY',
			readiness: notReady,
		});
	});

	it('logs one JSON line per gap, with the agent and subscription as fields', async () => {
		await expect(
			cueEngineStart({ dataDir: tmp, requireReady: true, logFormat: 'json' })
		).rejects.toThrow('__exit__');
		const lines = stderrSpy.mock.calls.map((call) => JSON.parse(String(call[0])));
		const gapLines = lines.filter((line) => line.event === 'readinessGap');
		expect(gapLines).toHaveLength(3);
		expect(gapLines[0]).toMatchObject({ level: 'error', sessionId: 'a-coder' });
		expect(gapLines[2]).toMatchObject({ subscriptionName: 'pr-review' });
	});

	it('never prints a secret value', async () => {
		await expect(cueEngineStart({ dataDir: tmp, requireReady: true })).rejects.toThrow('__exit__');
		await expect(
			cueEngineStart({ dataDir: tmp, requireReady: true, json: true, logFormat: 'json' })
		).rejects.toThrow('__exit__');
		expect(everythingPrinted()).not.toContain(SENTINEL);
	});
});

describe('cue engine start without --require-ready', () => {
	it('logs the gaps as warnings and starts anyway', async () => {
		const started = cueEngineStart({ dataDir: tmp });
		await vi.waitFor(() => expect(engine.start).toHaveBeenCalled());
		expect(createStandaloneCueEngine).toHaveBeenCalled();
		expect(everythingPrinted()).toContain('Not ready [binary-missing]');
		void started; // blocks forever by design
	});
});

describe('cue engine check', () => {
	it('prints every gap and sets exit code 1 when not ready, without starting anything', async () => {
		await cueEngineCheck({ dataDir: tmp });
		expect(process.exitCode).toBe(1);
		expect(createStandaloneCueEngine).not.toHaveBeenCalled();
		const printed = everythingPrinted();
		expect(printed).toContain(
			'Not ready: 3 gap(s) across 2 agent(s), 1 workspace(s), 3 subscription(s).'
		);
		for (const gap of notReady.gaps) expect(printed).toContain(gap.message);
	});

	it('prints the report as JSON and exits 0 when ready', async () => {
		report.current = { ...notReady, ready: true, gaps: [] };
		await cueEngineCheck({ dataDir: tmp, json: true });
		expect(process.exitCode).toBeUndefined();
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({ ready: true, gaps: [] });
	});
});
