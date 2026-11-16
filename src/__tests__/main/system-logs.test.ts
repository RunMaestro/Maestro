/**
 * @file system-logs.test.ts
 *
 * `readSystemLogs()` / `clearSystemLogs()`: the reads and the clear behind
 * `maestro-cli logs`. They read the same two places the System Log Viewer does
 * and merge and filter them with the same shared functions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
	logger: { getLogs: vi.fn(), getMaxLogBuffer: vi.fn(() => 1000), clearLogs: vi.fn() },
}));

vi.mock('../../main/log-sources', () => ({
	readLogSource: vi.fn(),
}));

import { clearSystemLogs, readSystemLogs } from '../../main/system-logs';
import { logger } from '../../main/utils/logger';
import { readLogSource } from '../../main/log-sources';

const T = Date.parse('2026-11-13T04:24:10.000Z');

describe('readSystemLogs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// The logger keeps its buffer oldest first.
		vi.mocked(logger.getLogs).mockReturnValue([
			{ timestamp: T + 500, level: 'info', message: 'maestro first' },
			{ timestamp: T + 1500, level: 'warn', message: 'maestro second', context: 'Cue' },
		]);
		vi.mocked(readLogSource).mockResolvedValue({
			source: 'model-server',
			path: '/data/logs/model-server.log',
			exists: true,
			text:
				'[2026-11-13T04:24:10.000Z] Starting llama-server\n' +
				'[2026-11-13T04:24:11.000Z] 0.00.001.000 E srv  load_model: failed\n',
			truncated: false,
			size: 10,
			mtimeMs: T + 2000,
		});
	});

	it('interleaves every source newest first, as the viewer opens', async () => {
		const result = await readSystemLogs();
		expect(result.entries.map((e) => e.message)).toEqual([
			'maestro second',
			'srv  load_model: failed',
			'maestro first',
			'Starting llama-server',
		]);
		expect(result.matched).toBe(4);
		expect(result.sources).toEqual([
			{ id: 'maestro' },
			{ id: 'model-server', path: '/data/logs/model-server.log', exists: true, truncated: false },
		]);
		expect(logger.getLogs).toHaveBeenCalledWith({ limit: 1000 });
	});

	it('reads only the named sources', async () => {
		const result = await readSystemLogs({ sources: ['model-server'] });
		expect(result.entries.every((e) => e.source === 'model-server')).toBe(true);
		expect(logger.getLogs).not.toHaveBeenCalled();

		vi.mocked(readLogSource).mockClear();
		await readSystemLogs({ sources: ['maestro'] });
		expect(readLogSource).not.toHaveBeenCalled();
	});

	it('filters by level and search, then keeps the newest limit', async () => {
		const result = await readSystemLogs({ levels: ['warn', 'error'], limit: 1 });
		expect(result.entries.map((e) => e.message)).toEqual(['maestro second']);
		expect(result.matched).toBe(2);
		const searched = await readSystemLogs({ search: 'LOAD_MODEL' });
		expect(searched.entries.map((e) => e.message)).toEqual(['srv  load_model: failed']);
	});

	it('reports a file it cannot read and still returns the rest', async () => {
		vi.mocked(readLogSource).mockRejectedValue(new Error('EACCES'));
		const result = await readSystemLogs();
		expect(result.entries.map((e) => e.message)).toEqual(['maestro second', 'maestro first']);
		expect(result.sources).toContainEqual({ id: 'model-server', error: 'EACCES' });
	});
});

describe('clearSystemLogs', () => {
	it("clears Maestro's own log only", () => {
		clearSystemLogs();
		expect(logger.clearLogs).toHaveBeenCalledTimes(1);
	});
});
