import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	DEFAULT_HISTORY_PAGE_SIZE,
	historyFilePath,
	legacyHistoryFilePath,
	pageHistoryEntries,
	readHistory,
	type HistoryEntry,
} from '../read-history';

function entry(id: string, timestamp: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return { id, type: 'USER', timestamp, summary: `summary ${id}`, projectPath: '/p', ...overrides };
}

function jsonl(entries: unknown[]): string {
	return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

describe('readHistory', () => {
	let historyDir: string;
	const paths = () => ({ historyDir });

	function write(name: string, content: string): string {
		const file = path.join(historyDir, name);
		fs.writeFileSync(file, content);
		return file;
	}

	beforeEach(() => {
		historyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-history-'));
	});

	afterEach(() => {
		fs.rmSync(historyDir, { recursive: true, force: true });
	});

	it('reads a JSONL file newest first', () => {
		write('agent-1.jsonl', jsonl([entry('a', 1), entry('b', 2), entry('c', 3)]));
		const result = readHistory(paths(), 'agent-1');
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		expect(result.format).toBe('jsonl');
		expect(result.entries.map((e) => e.id)).toEqual(['c', 'b', 'a']);
		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(false);
		expect(result.malformedLines).toBe(0);
	});

	it('tolerates a torn last line: keeps every whole entry and counts the torn one', () => {
		const whole = jsonl([entry('a', 1), entry('b', 2)]);
		write('agent-1.jsonl', `${whole}{"id":"c","type":"USER","timest`);
		const result = readHistory(paths(), 'agent-1');
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		expect(result.entries.map((e) => e.id)).toEqual(['b', 'a']);
		expect(result.malformedLines).toBe(1);
	});

	it('orders by timestamp, not append order', () => {
		// A long turn is appended when it FINISHES, after a shorter one that started later.
		write('agent-1.jsonl', jsonl([entry('late-start', 20), entry('early-start', 10)]));
		const result = readHistory(paths(), 'agent-1');
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		expect(result.entries.map((e) => e.id)).toEqual(['late-start', 'early-start']);
	});

	it('pages backward with limit and before', () => {
		write('agent-1.jsonl', jsonl([1, 2, 3, 4, 5].map((t) => entry(`e${t}`, t))));
		const first = readHistory(paths(), 'agent-1', { limit: 2 });
		if (first.status !== 'ok') throw new Error('expected ok');
		expect(first.entries.map((e) => e.id)).toEqual(['e5', 'e4']);
		expect(first.hasMore).toBe(true);
		expect(first.nextBefore).toBe(4);

		const second = readHistory(paths(), 'agent-1', { limit: 2, before: first.nextBefore });
		if (second.status !== 'ok') throw new Error('expected ok');
		expect(second.entries.map((e) => e.id)).toEqual(['e3', 'e2']);

		const third = readHistory(paths(), 'agent-1', { limit: 2, before: second.nextBefore });
		if (third.status !== 'ok') throw new Error('expected ok');
		expect(third.entries.map((e) => e.id)).toEqual(['e1']);
		expect(third.hasMore).toBe(false);
	});

	it('re-maps legacy AUTO consults to AGENT, as the desktop does', () => {
		write(
			'agent-1.jsonl',
			jsonl([entry('consult', 1, { type: 'AUTO', sourceAgentName: 'Other agent' })])
		);
		const result = readHistory(paths(), 'agent-1');
		if (result.status !== 'ok') throw new Error('expected ok');
		expect(result.entries[0].type).toBe('AGENT');
	});

	it('reads a legacy .json file in place without migrating it', () => {
		const legacy = JSON.stringify({
			version: 1,
			sessionId: 'agent-1',
			projectPath: '/p',
			// Legacy files are newest-first.
			entries: [entry('new', 2), entry('old', 1)],
		});
		const file = write('agent-1.json', legacy);
		const result = readHistory(paths(), 'agent-1');
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		expect(result.format).toBe('legacy-json');
		expect(result.entries.map((e) => e.id)).toEqual(['new', 'old']);
		expect(fs.readFileSync(file, 'utf-8')).toBe(legacy);
		expect(fs.readdirSync(historyDir)).toEqual(['agent-1.json']);
	});

	it('prefers JSONL over a legacy file the desktop has not cleaned up', () => {
		write('agent-1.jsonl', jsonl([entry('fresh', 5)]));
		write('agent-1.json', JSON.stringify({ entries: [entry('stale', 1)] }));
		const result = readHistory(paths(), 'agent-1');
		if (result.status !== 'ok') throw new Error('expected ok');
		expect(result.entries.map((e) => e.id)).toEqual(['fresh']);
	});

	it('reports a corrupt legacy file and leaves it untouched', () => {
		const file = write('agent-1.json', '{"entries": [');
		const result = readHistory(paths(), 'agent-1');
		expect(result.status).toBe('corrupt');
		expect(fs.readFileSync(file, 'utf-8')).toBe('{"entries": [');
	});

	it('reports a legacy file whose entries are not an array as corrupt', () => {
		write('agent-1.json', JSON.stringify({ entries: 'nope' }));
		expect(readHistory(paths(), 'agent-1').status).toBe('corrupt');
		write('agent-1.json', JSON.stringify([entry('a', 1)]));
		expect(readHistory(paths(), 'agent-1').status).toBe('corrupt');
	});

	it('reports missing when the agent has no history yet', () => {
		const result = readHistory(paths(), 'agent-1');
		expect(result).toEqual({ status: 'missing', file: historyFilePath(historyDir, 'agent-1') });
	});

	it('reports a JSONL path that cannot be read as unreadable', () => {
		fs.mkdirSync(historyFilePath(historyDir, 'agent-1'));
		const result = readHistory(paths(), 'agent-1');
		expect(result.status).toBe('unreadable');
	});

	it('names files after the sanitized agent id', () => {
		expect(path.basename(historyFilePath(historyDir, 'a/b:c'))).toBe('a_b_c.jsonl');
		expect(path.basename(legacyHistoryFilePath(historyDir, 'a/b:c'))).toBe('a_b_c.json');
	});

	it('never writes to the history directory', () => {
		write('agent-1.jsonl', jsonl([entry('a', 1)]));
		const before = fs.statSync(path.join(historyDir, 'agent-1.jsonl')).mtimeMs;
		readHistory(paths(), 'agent-1');
		readHistory(paths(), 'agent-2');
		expect(fs.readdirSync(historyDir)).toEqual(['agent-1.jsonl']);
		expect(fs.statSync(path.join(historyDir, 'agent-1.jsonl')).mtimeMs).toBe(before);
	});
});

describe('pageHistoryEntries', () => {
	it('defaults to a page of DEFAULT_HISTORY_PAGE_SIZE', () => {
		const sorted = Array.from({ length: DEFAULT_HISTORY_PAGE_SIZE + 5 }, (_, i) =>
			entry(`e${i}`, 10_000 - i)
		);
		const page = pageHistoryEntries(sorted);
		expect(page.entries).toHaveLength(DEFAULT_HISTORY_PAGE_SIZE);
		expect(page.hasMore).toBe(true);
	});

	it('never ends a page inside a run of equal timestamps, so the cursor skips nothing', () => {
		const sorted = [entry('a', 9), entry('b', 7), entry('c', 7), entry('d', 7), entry('e', 5)];
		const first = pageHistoryEntries(sorted, { limit: 2 });
		expect(first.entries.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
		expect(first.nextBefore).toBe(7);
		const second = pageHistoryEntries(sorted, { limit: 2, before: first.nextBefore });
		expect(second.entries.map((e) => e.id)).toEqual(['e']);
	});

	it('returns an empty page past the oldest entry', () => {
		const page = pageHistoryEntries([entry('a', 5)], { before: 1 });
		expect(page).toEqual({ entries: [], total: 1, hasMore: false, malformedLines: 0 });
	});
});
