/**
 * An agent's History across a Federation move (`lift-history.ts`, L39): which host entries come
 * home, the merged list a hosted agent's panel reads, and the CLI's file store.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HistoryEntry } from '../../../types';
import {
	bringHostHistoryHome,
	historyEntryCount,
	hostHistoryComingHome,
	planHostHistoryHome,
	withLocalHistory,
} from '../lift-history';
import { diskAgentHistoryStore } from '../lift-history-disk';

const entry = (
	id: string,
	timestamp: number,
	sessionId?: string,
	extra: Partial<HistoryEntry> = {}
): HistoryEntry => ({
	id,
	type: 'AUTO',
	timestamp,
	summary: id,
	projectPath: '/work',
	...(sessionId ? { sessionId } : {}),
	...extra,
});

describe('hostHistoryComingHome', () => {
	it("takes only the host agent's own entries, re-filed under the local id, oldest first, each id once", () => {
		const coming = hostHistoryComingHome(
			[
				entry('b', 20, 'host-1'),
				entry('shared', 15, 'laptop-agent', { hostname: 'laptop' }),
				entry('a', 10, 'host-1'),
				entry('a', 10, 'host-1'),
				entry('no-owner', 5),
				entry('here', 1, 'host-1'),
			],
			'host-1',
			'local-1',
			[entry('here', 1, 'local-1')]
		);
		expect(coming.map((e) => [e.id, e.sessionId])).toEqual([
			['a', 'local-1'],
			['b', 'local-1'],
		]);
	});
});

describe('planHostHistoryHome and bringHostHistoryHome', () => {
	it('reads the host list and this machine, and writes only what is new', async () => {
		const store = { read: vi.fn(async () => [entry('x', 1, 'local-1')]), append: vi.fn() };
		const coming = await planHostHistoryHome(
			{ list: async () => ({ ok: true, value: [entry('x', 1, 'h'), entry('y', 2, 'h')] }) },
			'h',
			'local-1',
			store
		);
		expect(coming.map((e) => e.id)).toEqual(['y']);
		expect(store.append).not.toHaveBeenCalled();
		expect(await bringHostHistoryHome(store, 'local-1', coming)).toBe(1);
		expect(store.append).toHaveBeenCalledWith('local-1', coming);
		expect(await bringHostHistoryHome(store, 'local-1', [])).toBe(0);
		expect(store.append).toHaveBeenCalledTimes(1);
	});

	it('throws when the host cannot list the History', async () => {
		await expect(
			planHostHistoryHome(
				{ list: async () => ({ ok: false, error: { message: 'unreadable' } }) },
				'h',
				'l',
				{ read: async () => [] }
			)
		).rejects.toThrow('its History could not be read: unreadable');
	});
});

describe('withLocalHistory', () => {
	it("lists the host's entries and this machine's, newest first, the host's copy of a shared id", () => {
		const merged = withLocalHistory(
			[entry('h2', 30, 'host'), entry('both', 20, 'host', { summary: 'host copy' })],
			[entry('both', 20, 'local', { summary: 'local copy' }), entry('pre', 10, 'local')]
		);
		expect(merged.map((e) => e.id)).toEqual(['h2', 'both', 'pre']);
		expect(merged[1].summary).toBe('host copy');
	});
});

describe('historyEntryCount', () => {
	it('says entry or entries', () => {
		expect(historyEntryCount(1)).toBe('1 History entry');
		expect(historyEntryCount(0)).toBe('0 History entries');
		expect(historyEntryCount(16)).toBe('16 History entries');
	});
});

describe('diskAgentHistoryStore', () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("reads and appends an agent's own JSONL file, resolving the folder per call", async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lift-history-'));
		const historyDir = path.join(dir, 'history');
		fs.mkdirSync(historyDir);
		let resolved = 0;
		const store = diskAgentHistoryStore(() => {
			resolved += 1;
			return { historyDir };
		});
		expect(await store.read('local-1')).toEqual([]);
		await store.append('local-1', [entry('a', 10, 'local-1'), entry('b', 20, 'local-1')]);
		expect((await store.read('local-1')).map((e) => e.id)).toEqual(['b', 'a']);
		expect(resolved).toBeGreaterThanOrEqual(3);
	});
});
