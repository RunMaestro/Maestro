/**
 * `cue engine start --log-format json`: every line the engine process prints
 * is JSON, including the lines shared modules write with `console.*` directly
 * (`cueDebugLog` on a cue.yaml reload, `cue-self-destruct.ts`).
 *
 * A real `CueEngine` in standalone mode, the real YAML loader on a temporary
 * project, the real self-destruct and the real logger. Only `cue.db` and the
 * cross-process lock are mocked. "stdout" is everything that reaches the
 * process's stdout: `process.stdout.write`, and `console.log` as it was before
 * the logger took the console over (the logger keeps that one for results).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	pruneCueEvents: vi.fn(),
	failOrphanedRunningEvents: () => 0,
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
	getFanInState: vi.fn(() => []),
	safePersistFanInSource: vi.fn(),
	safeRemoveFanInState: vi.fn(),
}));

const CONSOLE_METHODS = ['log', 'debug', 'info', 'warn', 'error'] as const;

const SUB = (name: string) => `  - name: ${name}
    event: cli.trigger
    action: command
    command:
      mode: shell
      shell: echo ${name}
`;

let tmp: string;
let savedConsole: Record<string, unknown>;
let stdoutLines: string[];
let stderrLines: string[];

function splitLines(chunk: unknown): string[] {
	return String(chunk)
		.split('\n')
		.filter((line) => line !== '');
}

beforeEach(() => {
	vi.resetModules();
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-json-logs-')));
	fs.mkdirSync(path.join(tmp, '.maestro'));
	fs.writeFileSync(path.join(tmp, '.maestro', 'cue.yaml'), `subscriptions:\n${SUB('one')}`);
	savedConsole = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));
	stdoutLines = [];
	stderrLines = [];
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
		stdoutLines.push(...splitLines(chunk));
		return true;
	});
	vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
		stderrLines.push(...splitLines(chunk));
		return true;
	});
	// The process's stdout console, before anything takes it over.
	console.log = (...args: unknown[]) => stdoutLines.push(...splitLines(args.map(String).join(' ')));
	for (const m of ['debug', 'info'] as const) console[m] = console.log;
	console.warn = (...args: unknown[]) =>
		stderrLines.push(...splitLines(args.map(String).join(' ')));
	console.error = console.warn;
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const m of CONSOLE_METHODS)
		(console as unknown as Record<string, unknown>)[m] = savedConsole[m];
	fs.rmSync(tmp, { recursive: true, force: true });
});

/** Start an engine on `tmp`, reload its cue.yaml, and self-destruct one subscription. */
async function reloadAndSelfDestruct(
	onLog: (level: string, message: string, data?: unknown) => void
) {
	const { CueEngine } = await import('../../../main/cue/cue-engine');
	const { removeSubscriptionFromYaml } = await import('../../../main/cue/cue-self-destruct');
	const engine = new CueEngine({
		runnerMode: 'standalone',
		getSessions: () => [
			{ id: 'agent-1', name: 'alpha', toolType: 'claude-code', cwd: tmp, projectRoot: tmp },
		],
		onCueRun: vi.fn(),
		onStopCueRun: vi.fn(() => true),
		onLog,
	} as never);
	engine.start();
	fs.writeFileSync(
		path.join(tmp, '.maestro', 'cue.yaml'),
		`subscriptions:\n${SUB('one')}${SUB('two')}`
	);
	engine.refreshSession('agent-1', tmp);
	const removed = await removeSubscriptionFromYaml(tmp, 'two');
	engine.stop();
	expect(removed).toEqual({ removed: true });
}

describe('--log-format json', () => {
	it('prints JSON lines only, with debug output dropped at the default level', async () => {
		const { logger } = await import('../../../main/utils/logger');
		const { jsonCueLog } = await import('../../../cli/services/cue-standalone-engine');
		logger.consoleJson();
		logger.writeStdout(JSON.stringify({ started: true }));

		await reloadAndSelfDestruct(jsonCueLog);

		expect(stdoutLines).toEqual(['{"started":true}']);
		expect(stderrLines.length).toBeGreaterThan(0);
		for (const line of [...stdoutLines, ...stderrLines])
			expect(() => JSON.parse(line)).not.toThrow();
		const all = [...stdoutLines, ...stderrLines].join('\n');
		expect(all).not.toContain('[CueDebug]');
		expect(all).toContain('Config reloaded');
	});

	it('keeps the debug lines as JSON at level debug, with only the ids from their payload', async () => {
		const { logger } = await import('../../../main/utils/logger');
		const { jsonCueLog } = await import('../../../cli/services/cue-standalone-engine');
		logger.consoleJson();
		logger.setLogLevel('debug');

		await reloadAndSelfDestruct(jsonCueLog);

		expect(stdoutLines).toEqual([]);
		const lines = stderrLines.map((line) => JSON.parse(line));
		const debug = lines.find((l) => l.message === '[CueDebug] engine:refreshSession:start');
		expect(debug).toMatchObject({ level: 'debug', sessionId: 'agent-1' });
		expect(lines.some((l) => /self-destruct removed "two"/.test(l.message))).toBe(true);
		// The payload's project path is not an identifier field.
		expect(JSON.stringify(debug)).not.toContain(tmp);
	});
});

describe('--log-format text and the desktop (no consoleJson)', () => {
	it('leave the console alone: debug and self-destruct text print as before', async () => {
		const { logger } = await import('../../../main/utils/logger');
		const before = console.log;
		logger.writeStdout('result');

		await reloadAndSelfDestruct(vi.fn());

		expect(console.log).toBe(before);
		expect(stdoutLines[0]).toBe('result');
		expect(stdoutLines).toContain('[CueDebug] engine:refreshSession:start [object Object]');
		expect(stdoutLines.some((l) => l.startsWith('[CUE] self-destruct removed "two"'))).toBe(true);
	});
});
