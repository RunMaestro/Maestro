/**
 * @file logs.test.ts
 * @description `maestro-cli logs`: the System Log Viewer's read (pills, search,
 * Export) and its Clear button, over the `system_logs` bridge messages.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { logs, logsClear } from '../../../cli/commands/logs';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import type { SystemLogsResult } from '../../../shared/logSources';

function mockSend(result: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string } = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				captured.payload = payload;
				captured.responseType = rt;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return captured;
}

const RESULT: SystemLogsResult = {
	entries: [
		{
			timestamp: Date.parse('2026-11-13T04:24:12.000Z'),
			level: 'error',
			message: 'srv  load_model: failed',
			context: 'model-server',
			source: 'model-server',
		},
		{
			timestamp: Date.parse('2026-11-13T04:24:11.000Z'),
			level: 'info',
			message: 'maestro between',
		},
	],
	matched: 5,
	sources: [
		{ id: 'maestro' },
		{ id: 'model-server', path: '/data/logs/model-server.log', exists: true, truncated: true },
	],
};

describe('logs command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;
	let dir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-logs-cli-'));
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('sends the pills, levels, search and limit as the query', async () => {
		const cap = mockSend({ success: true, result: RESULT });
		await logs({
			source: 'model-server, maestro',
			level: 'warn,error',
			search: 'load',
			limit: '2',
		});
		expect(cap.responseType).toBe('system_logs_result');
		expect(cap.payload).toEqual({
			type: 'system_logs',
			query: {
				sources: ['model-server', 'maestro'],
				levels: ['warn', 'error'],
				search: 'load',
				limit: 2,
			},
		});
	});

	it('sends an empty query by default: every source and level, as the viewer opens', async () => {
		const cap = mockSend({ success: true, result: RESULT });
		await logs({});
		expect(cap.payload).toEqual({ type: 'system_logs', query: {} });
	});

	it("prints the entries in the viewer's Export format, with the source notes", async () => {
		mockSend({ success: true, result: RESULT });
		await logs({});
		expect(String(logSpy.mock.calls[0][0])).toBe(
			'[2026-11-13T04:24:12.000Z] [ERROR] [model-server] srv  load_model: failed\n\n' +
				'[2026-11-13T04:24:11.000Z] [INFO]  maestro between'
		);
		const notes = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
		expect(notes).toContain('Older model-server lines are not shown.');
		expect(notes).toContain('Showing the newest 2 of 5 matching entries.');
	});

	it('prints the whole result as JSON with --json', async () => {
		mockSend({ success: true, result: RESULT });
		await logs({ json: true });
		const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(parsed).toEqual({ success: true, ...RESULT });
	});

	it('writes the Export text to --output and reports it', async () => {
		mockSend({ success: true, result: RESULT });
		const file = path.join(dir, 'logs.txt');
		await logs({ output: file, json: true });
		expect(fs.readFileSync(file, 'utf8')).toContain(
			'[ERROR] [model-server] srv  load_model: failed'
		);
		const parsed = JSON.parse(String(logSpy.mock.calls[0][0]));
		expect(parsed).toMatchObject({ success: true, path: file, written: 2, matched: 5 });
		expect(parsed.entries).toBeUndefined();
	});

	it('exits non-zero with the reason when the app refuses the query', async () => {
		mockSend({ success: false, error: 'Unknown log source: nope.' });
		await expect(logs({ source: 'nope' })).rejects.toThrow('__exit__');
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
	});
});

describe('logs clear command', () => {
	let logSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it("asks the app to clear Maestro's log and says so", async () => {
		const cap = mockSend({ success: true });
		await logsClear({ json: true });
		expect(cap.payload).toEqual({ type: 'system_logs_clear' });
		expect(cap.responseType).toBe('system_logs_clear_result');
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
			success: true,
			cleared: 'maestro',
		});
	});
});
