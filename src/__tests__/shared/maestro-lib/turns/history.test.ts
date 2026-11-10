/**
 * The runtime's History writer, against the desktop's own reader and manager.
 *
 * The desktop's `HistoryManager` owns `<userData>/history/<agentId>.jsonl`. These tests write
 * with the library's writer and read with the real manager (and the library reader), on a real
 * temp directory.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userData) } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { HistoryManager } from '../../../../main/history-manager';
import { createHistoryWriter } from '../../../../shared/maestro-lib/turns/history';
import { readHistory } from '../../../../shared/maestro-lib/store/read-history';
import { setMaestroLibLogger } from '../../../../shared/maestro-lib/host';
import type { HistoryEntry } from '../../../../shared/types';

const entry = (id: string, timestamp: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id,
	type: 'USER',
	timestamp,
	summary: `summary ${id}`,
	projectPath: '/work/a1',
	sessionId: 'a1',
	...extra,
});

describe('createHistoryWriter', () => {
	let historyDir: string;

	beforeEach(() => {
		userData = fs.mkdtempSync(path.join(os.tmpdir(), 'history-writer-test-'));
		historyDir = path.join(userData, 'history');
	});
	afterEach(() => {
		fs.rmSync(userData, { recursive: true, force: true });
	});

	it('creates the history directory and a line the desktop manager reads back whole', async () => {
		const writer = createHistoryWriter({ paths: { historyDir } });
		const written = entry('e1', 1_700_000_000_000, {
			fullResponse: 'The full answer.',
			agentSessionId: 'sess-1',
			sessionName: 'SESS-1',
			tabId: 'tab-1',
			elapsedTimeMs: 4200,
			success: true,
			contextUsage: 12,
		});
		const result = await writer.append('a1', written);
		expect(result).toEqual({ ok: true, file: path.join(historyDir, 'a1.jsonl') });

		const manager = new HistoryManager();
		expect(await manager.getEntries('a1')).toEqual([written]);
	});

	it('is read by the library reader too, and appends in call order', async () => {
		const writer = createHistoryWriter({ paths: { historyDir } });
		await Promise.all([
			writer.append('a1', entry('e1', 1)),
			writer.append('a1', entry('e2', 2)),
			writer.append('a1', entry('e3', 3)),
		]);
		const lines = fs.readFileSync(path.join(historyDir, 'a1.jsonl'), 'utf-8').trim().split('\n');
		expect(lines.map((line) => JSON.parse(line).id)).toEqual(['e1', 'e2', 'e3']);
		const read = readHistory({ historyDir }, 'a1');
		expect(read.status === 'ok' && read.entries.map((e) => e.id)).toEqual(['e3', 'e2', 'e1']);
	});

	it('appends after what the desktop manager wrote, and the manager reads both', async () => {
		const manager = new HistoryManager();
		await manager.initialize();
		await manager.addEntry('a1', '/work/a1', entry('desktop', 1));
		await createHistoryWriter({ paths: { historyDir } }).append('a1', entry('runtime', 2));
		await manager.addEntry('a1', '/work/a1', entry('desktop-2', 3));
		expect((await manager.getEntries('a1')).map((e) => e.id)).toEqual([
			'desktop-2',
			'runtime',
			'desktop',
		]);
	});

	it('closes a torn last line instead of fusing the new entry onto it', async () => {
		fs.mkdirSync(historyDir, { recursive: true });
		const file = path.join(historyDir, 'a1.jsonl');
		fs.writeFileSync(file, `${JSON.stringify(entry('good', 1))}\n{"id":"torn","type":"USER","time`);
		await createHistoryWriter({ paths: { historyDir } }).append('a1', entry('after', 2));
		const read = readHistory({ historyDir }, 'a1');
		expect(read.status === 'ok' && read.entries.map((e) => e.id)).toEqual(['after', 'good']);
		expect(read.status === 'ok' && read.malformedLines).toBe(1);
	});

	it('refuses an agent still on the legacy file rather than hiding its old entries', async () => {
		fs.mkdirSync(historyDir, { recursive: true });
		const legacy = path.join(historyDir, 'a1.json');
		fs.writeFileSync(legacy, JSON.stringify({ version: 1, entries: [entry('old', 1)] }));
		const result = await createHistoryWriter({ paths: { historyDir } }).append(
			'a1',
			entry('new', 2)
		);
		expect(result).toMatchObject({ ok: false, reason: 'legacy-format' });
		expect(fs.existsSync(path.join(historyDir, 'a1.jsonl'))).toBe(false);
		const read = readHistory({ historyDir }, 'a1');
		expect(read.status === 'ok' && read.entries.map((e) => e.id)).toEqual(['old']);
	});

	it('writes nothing once the fence says another process owns the data directory', async () => {
		const writer = createHistoryWriter({
			paths: { historyDir },
			fence: () => ({ ok: false, reason: 'Another Maestro took over.' }),
		});
		expect(await writer.append('a1', entry('e1', 1))).toEqual({
			ok: false,
			reason: 'fenced',
			message: 'Another Maestro took over.',
		});
		expect(fs.existsSync(historyDir)).toBe(false);
	});

	it('reports a failed write as a result instead of throwing', async () => {
		fs.writeFileSync(historyDir, 'a file where the directory should be');
		const result = await createHistoryWriter({ paths: { historyDir } }).append(
			'a1',
			entry('e1', 1)
		);
		expect(result).toMatchObject({ ok: false, reason: 'failed' });
	});

	it('keeps an agent id from climbing out of the history directory', async () => {
		const result = await createHistoryWriter({ paths: { historyDir } }).append(
			'../escape',
			entry('e1', 1)
		);
		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(userData, 'escape.jsonl'))).toBe(false);
		expect(fs.readdirSync(historyDir)).toHaveLength(1);
	});

	describe('onAppended', () => {
		const noop = () => undefined;
		afterEach(() => {
			setMaestroLibLogger({ debug: noop, info: noop, warn: noop, error: noop });
		});

		it('is called with each entry after it is on disk, in append order', async () => {
			const seen: Array<{ agentId: string; id: string; onDisk: boolean }> = [];
			const writer = createHistoryWriter({
				paths: { historyDir },
				onAppended: (agentId, appended) => {
					const file = path.join(historyDir, `${agentId}.jsonl`);
					seen.push({
						agentId,
						id: appended.id,
						onDisk: fs.readFileSync(file, 'utf-8').includes(`"id":"${appended.id}"`),
					});
				},
			});
			await Promise.all([writer.append('a1', entry('e1', 1)), writer.append('a1', entry('e2', 2))]);
			await writer.append('b2', entry('e3', 3));
			expect(seen).toEqual([
				{ agentId: 'a1', id: 'e1', onDisk: true },
				{ agentId: 'a1', id: 'e2', onDisk: true },
				{ agentId: 'b2', id: 'e3', onDisk: true },
			]);
		});

		it('is not called when the append did not happen', async () => {
			const onAppended = vi.fn();
			const fenced = createHistoryWriter({
				paths: { historyDir },
				fence: () => ({ ok: false, reason: 'Another Maestro took over.' }),
				onAppended,
			});
			expect((await fenced.append('a1', entry('e1', 1))).ok).toBe(false);
			fs.writeFileSync(historyDir, 'a file where the directory should be');
			const failing = createHistoryWriter({ paths: { historyDir }, onAppended });
			expect((await failing.append('a1', entry('e2', 2))).ok).toBe(false);
			expect(onAppended).not.toHaveBeenCalled();
		});

		it('logs a hook that throws, and the append still succeeds', async () => {
			const warn = vi.fn();
			setMaestroLibLogger({ debug: noop, info: noop, warn, error: noop });
			const writer = createHistoryWriter({
				paths: { historyDir },
				onAppended: () => {
					throw new Error('share failed');
				},
			});
			const result = await writer.append('a1', entry('e1', 1));
			expect(result).toEqual({ ok: true, file: path.join(historyDir, 'a1.jsonl') });
			expect(warn).toHaveBeenCalledWith(
				'After-append hook failed for agent a1: share failed',
				expect.any(String)
			);
			// The queue keeps going after a throwing hook.
			expect((await writer.append('a1', entry('e2', 2))).ok).toBe(true);
			const read = readHistory({ historyDir }, 'a1');
			expect(read.status === 'ok' && read.entries.map((e) => e.id)).toEqual(['e2', 'e1']);
		});
	});
});
