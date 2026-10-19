/**
 * Tests for the User Journey store: one JSONL file per agent, append with
 * collapse, cap and retention pruning, read filters, and delete.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => '/mock/userData'),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// An in-memory file system: enough of fs/promises for append, read, the
// atomic temp-file-then-rename rewrite, and unlink.
const { files, enoent } = vi.hoisted(() => {
	const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
	return { files: new Map<string, string>(), enoent };
});

vi.mock('fs/promises', () => ({
	mkdir: vi.fn(async () => undefined),
	readFile: vi.fn(async (p: string) => {
		const contents = files.get(p);
		if (contents === undefined) throw enoent();
		return contents;
	}),
	appendFile: vi.fn(async (p: string, data: string) => {
		files.set(p, (files.get(p) ?? '') + data);
	}),
	writeFile: vi.fn(async (p: string, data: string) => {
		files.set(p, data);
	}),
	rename: vi.fn(async (from: string, to: string) => {
		const data = files.get(from);
		if (data === undefined) throw enoent();
		files.delete(from);
		files.set(to, data);
	}),
	unlink: vi.fn(async (p: string) => {
		if (!files.delete(p)) throw enoent();
	}),
}));

import * as fsp from 'fs/promises';
import { captureException } from '../../main/utils/sentry';
import {
	JOURNEY_MAX_ENTRIES_PER_AGENT,
	JOURNEY_RETENTION_DAYS,
	type UserJourneyEntry,
} from '../../shared/userJourney';

type Manager = typeof import('../../main/user-journey-manager');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

function entry(overrides: Partial<UserJourneyEntry> = {}): UserJourneyEntry {
	return {
		ts: NOW,
		agentId: 'agent-1',
		kind: 'file.open',
		target: '/repo/src/foo.ts',
		tabId: 'tab-1',
		...overrides,
	};
}

function linesOf(filePath: string): UserJourneyEntry[] {
	return (files.get(filePath) ?? '')
		.split('\n')
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe('user-journey-manager', () => {
	let m: Manager;

	beforeEach(async () => {
		files.clear();
		vi.clearAllMocks();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(NOW);
		// Fresh module per test: the store caches per-agent file state.
		vi.resetModules();
		m = await import('../../main/user-journey-manager');
	});

	describe('getJourneyFilePath', () => {
		it('puts each agent in its own JSONL file under userData/journey', () => {
			expect(m.getJourneyFilePath('agent-1')).toBe(
				path.join('/mock/userData', 'journey', 'agent-1.jsonl')
			);
		});

		it('sanitizes the agent id so it cannot escape the directory', () => {
			expect(path.basename(m.getJourneyFilePath('../evil/id'))).toBe('___evil_id.jsonl');
		});
	});

	describe('appendJourneyEntry', () => {
		it('appends one JSON line per entry, oldest first', async () => {
			await m.appendJourneyEntry(entry({ ts: NOW - 2000 }));
			await m.appendJourneyEntry(entry({ ts: NOW - 1000, kind: 'file.save', linesAdded: 3 }));

			const lines = linesOf(m.getJourneyFilePath('agent-1'));
			expect(lines.map((e) => e.kind)).toEqual(['file.open', 'file.save']);
			expect(lines[1].linesAdded).toBe(3);
		});

		it('keeps only known metadata fields', async () => {
			await m.appendJourneyEntry({
				...entry(),
				content: 'secret file body',
			} as UserJourneyEntry);

			const [line] = linesOf(m.getJourneyFilePath('agent-1'));
			expect(line).not.toHaveProperty('content');
		});

		it('strips the query string from a browser target the recorder forgot to sanitize', async () => {
			await m.appendJourneyEntry(
				entry({ kind: 'browser.open', target: 'https://example.com/a?token=abc#x' })
			);

			const [line] = linesOf(m.getJourneyFilePath('agent-1'));
			expect(line.target).toBe('https://example.com/a');
		});

		it('drops a malformed entry without writing', async () => {
			const written = await m.appendJourneyEntry({ ...entry(), kind: 'nope' } as never);

			expect(written).toBe(false);
			expect(files.size).toBe(0);
		});

		it('collapses a repeated browser.navigate on the same tab and URL', async () => {
			const nav = entry({ kind: 'browser.navigate', target: 'https://docs.runmaestro.ai/cue' });
			expect(await m.appendJourneyEntry(nav)).toBe(true);
			expect(await m.appendJourneyEntry({ ...nav, ts: NOW + 10 })).toBe(false);
			// A hash change sanitizes to the same target, so it collapses too.
			expect(
				await m.appendJourneyEntry({ ...nav, ts: NOW + 20, target: `${nav.target}#section` })
			).toBe(false);
			expect(await m.appendJourneyEntry({ ...nav, ts: NOW + 30, tabId: 'tab-2' })).toBe(true);

			expect(linesOf(m.getJourneyFilePath('agent-1'))).toHaveLength(2);
		});

		it('collapses against the last entry already on disk from a previous run', async () => {
			const nav = entry({ kind: 'browser.navigate', target: 'https://example.com/' });
			files.set(m.getJourneyFilePath('agent-1'), `${JSON.stringify(nav)}\n`);

			expect(await m.appendJourneyEntry({ ...nav, ts: NOW + 10 })).toBe(false);
		});

		it('serializes rapid appends so none interleave or are lost', async () => {
			const results = await Promise.all(
				Array.from({ length: 20 }, (_, i) =>
					m.appendJourneyEntry(entry({ ts: NOW + i, target: `/repo/f${i}.ts` }))
				)
			);

			expect(results.every(Boolean)).toBe(true);
			const lines = linesOf(m.getJourneyFilePath('agent-1'));
			expect(lines.map((e) => e.target)).toEqual(
				Array.from({ length: 20 }, (_, i) => `/repo/f${i}.ts`)
			);
		});

		it('keeps agents in separate files', async () => {
			await m.appendJourneyEntry(entry({ agentId: 'a' }));
			await m.appendJourneyEntry(entry({ agentId: 'b' }));

			expect(linesOf(m.getJourneyFilePath('a'))).toHaveLength(1);
			expect(linesOf(m.getJourneyFilePath('b'))).toHaveLength(1);
		});

		it('reports a failed write and resolves false instead of throwing', async () => {
			vi.mocked(fsp.appendFile).mockRejectedValueOnce(
				Object.assign(new Error('disk full'), { code: 'ENOSPC' })
			);

			await expect(m.appendJourneyEntry(entry())).resolves.toBe(false);
			expect(captureException).toHaveBeenCalledWith(
				expect.any(Error),
				expect.objectContaining({ operation: 'journey:append', agentId: 'agent-1' })
			);
		});
	});

	describe('pruning', () => {
		it('does not rewrite the file on an ordinary append', async () => {
			await m.appendJourneyEntry(entry());
			await m.appendJourneyEntry(entry({ ts: NOW + 1, target: '/repo/b.ts' }));

			expect(fsp.writeFile).not.toHaveBeenCalled();
		});

		it('prunes to the entry cap once the file grows well past it', async () => {
			const filePath = m.getJourneyFilePath('agent-1');
			const overCap = JOURNEY_MAX_ENTRIES_PER_AGENT + 500;
			files.set(
				filePath,
				Array.from({ length: overCap }, (_, i) =>
					JSON.stringify(entry({ ts: NOW - overCap + i, target: `/repo/f${i}.ts` }))
				).join('\n') + '\n'
			);

			// The file sits exactly at cap + slack; one more append tips it over.
			await m.appendJourneyEntry(entry({ ts: NOW, target: '/repo/new-1.ts' }));
			expect(fsp.writeFile).toHaveBeenCalledTimes(1);

			const lines = linesOf(filePath);
			expect(lines).toHaveLength(JOURNEY_MAX_ENTRIES_PER_AGENT);
			// The newest entries survive; the oldest are gone.
			expect(lines[lines.length - 1].target).toBe('/repo/new-1.ts');
			expect(lines[0].target).toBe(`/repo/f${overCap + 1 - JOURNEY_MAX_ENTRIES_PER_AGENT}.ts`);
		});

		it('prunes entries past retention once the oldest is a day overdue', async () => {
			const filePath = m.getJourneyFilePath('agent-1');
			const stale = entry({ ts: NOW - (JOURNEY_RETENTION_DAYS + 2) * DAY_MS, target: '/old.ts' });
			const fresh = entry({ ts: NOW - DAY_MS, target: '/fresh.ts' });
			files.set(filePath, `${JSON.stringify(stale)}\n${JSON.stringify(fresh)}\n`);

			await m.appendJourneyEntry(entry({ target: '/new.ts' }));

			expect(linesOf(filePath).map((e) => e.target)).toEqual(['/fresh.ts', '/new.ts']);
		});

		it('leaves an entry just past retention for the slack window', async () => {
			const filePath = m.getJourneyFilePath('agent-1');
			const barelyStale = entry({
				ts: NOW - JOURNEY_RETENTION_DAYS * DAY_MS - 1000,
				target: '/old.ts',
			});
			files.set(filePath, `${JSON.stringify(barelyStale)}\n`);

			await m.appendJourneyEntry(entry({ target: '/new.ts' }));

			expect(fsp.writeFile).not.toHaveBeenCalled();
			// Readers still never see it.
			expect((await m.readJourney('agent-1')).map((e) => e.target)).toEqual(['/new.ts']);
		});
	});

	describe('readJourney', () => {
		beforeEach(async () => {
			await m.appendJourneyEntry(entry({ ts: NOW - 3000, target: '/a.ts' }));
			await m.appendJourneyEntry(entry({ ts: NOW - 2000, kind: 'file.save', target: '/a.ts' }));
			await m.appendJourneyEntry(
				entry({ ts: NOW - 1000, kind: 'browser.open', target: 'https://example.com/' })
			);
		});

		it('returns entries oldest first', async () => {
			const entries = await m.readJourney('agent-1');
			expect(entries.map((e) => e.ts)).toEqual([NOW - 3000, NOW - 2000, NOW - 1000]);
		});

		it('filters by since', async () => {
			const entries = await m.readJourney('agent-1', { since: NOW - 2000 });
			expect(entries.map((e) => e.kind)).toEqual(['file.save', 'browser.open']);
		});

		it('filters by kinds', async () => {
			const entries = await m.readJourney('agent-1', { kinds: ['file.open', 'browser.open'] });
			expect(entries.map((e) => e.kind)).toEqual(['file.open', 'browser.open']);
		});

		it('returns the newest N with tail, still oldest first', async () => {
			const entries = await m.readJourney('agent-1', { tail: 2 });
			expect(entries.map((e) => e.kind)).toEqual(['file.save', 'browser.open']);
			expect(await m.readJourney('agent-1', { tail: 0 })).toEqual([]);
		});

		it('combines filters before taking the tail', async () => {
			const entries = await m.readJourney('agent-1', {
				kinds: ['file.open', 'file.save'],
				tail: 1,
			});
			expect(entries.map((e) => e.kind)).toEqual(['file.save']);
		});

		it('skips torn or foreign lines', async () => {
			const filePath = m.getJourneyFilePath('agent-1');
			files.set(filePath, `${files.get(filePath)}{"not":"an entry"}\n{"ts":`);

			expect(await m.readJourney('agent-1')).toHaveLength(3);
		});

		it('returns an empty list for an agent with no journey', async () => {
			expect(await m.readJourney('nobody')).toEqual([]);
		});
	});

	describe('deleteJourney', () => {
		it('removes the file and forgets the cached last entry', async () => {
			const nav = entry({ kind: 'browser.navigate', target: 'https://example.com/' });
			await m.appendJourneyEntry(nav);

			await m.deleteJourney('agent-1');
			expect(files.has(m.getJourneyFilePath('agent-1'))).toBe(false);

			// Without the cached entry, the same navigate is new again.
			expect(await m.appendJourneyEntry({ ...nav, ts: NOW + 1 })).toBe(true);
		});

		it('is a quiet no-op when the agent has no journey', async () => {
			await expect(m.deleteJourney('nobody')).resolves.toBeUndefined();
			expect(captureException).not.toHaveBeenCalled();
		});

		it('runs after a pending append so it cannot be resurrected', async () => {
			const append = m.appendJourneyEntry(entry());
			const del = m.deleteJourney('agent-1');
			await Promise.all([append, del]);

			expect(files.has(m.getJourneyFilePath('agent-1'))).toBe(false);
		});
	});
});
