import { describe, it, expect } from 'vitest';
import type { SessionsDocument } from '../records';
import {
	findTabTranscript,
	LOG_ENTRY_SOURCES,
	sliceTranscript,
	transcriptOf,
	type LogEntryRecord,
} from '../transcript';

const userEntry = {
	id: 'log-1',
	timestamp: 1,
	source: 'user',
	text: '# Heading\n\nhello',
	rcOnlyLogField: { keep: true },
};
const toolEntry = {
	id: 'log-2',
	timestamp: 2,
	source: 'tool',
	text: 'Read',
	metadata: { toolState: { status: 'completed', input: { file: 'a.ts' } } },
};
const futureEntry = { id: 'log-3', timestamp: 3, source: 'source-from-the-future', text: 'x' };

const DOCUMENT: SessionsDocument = {
	sessions: [
		{
			id: 'agent-1',
			name: 'Maestro',
			toolType: 'claude-code',
			aiTabs: [
				{
					id: 'tab-1',
					logs: [userEntry, { id: 'no-text', timestamp: 4 }, 7, toolEntry, futureEntry],
				},
				{ id: 'consult', hidden: true, logs: [{ ...userEntry, id: 'c-1' }] },
				{ id: 'empty' },
			],
		},
	],
};

describe('transcript accessor', () => {
	it('returns the original entries in stored order, unknown keys intact', () => {
		const result = findTabTranscript(DOCUMENT, 'agent-1', 'tab-1');
		if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
		expect(result.entries.map((e) => e.id)).toEqual(['log-1', 'log-2', 'log-3']);
		expect(result.entries[0]).toBe(userEntry);
		expect(result.entries[0].rcOnlyLogField).toEqual({ keep: true });
		expect(result.entries[1].metadata?.toolState?.status).toBe('completed');
	});

	it('keeps an entry kind from a newer build rather than dropping it', () => {
		const result = findTabTranscript(DOCUMENT, 'agent-1', 'tab-1');
		if (result.status !== 'ok') throw new Error('expected ok');
		expect(result.entries[2].source).toBe('source-from-the-future');
	});

	it('skips undrawable entries without removing them from the tab', () => {
		const tab = (DOCUMENT.sessions as Array<{ aiTabs: Array<{ logs?: unknown[] }> }>)[0].aiTabs[0];
		expect(tab.logs).toHaveLength(5);
		expect(transcriptOf(tab as never)).toHaveLength(3);
	});

	it('finds a hidden consult tab like any other', () => {
		const result = findTabTranscript(DOCUMENT, 'agent-1', 'consult');
		expect(result.status).toBe('ok');
	});

	it('returns an empty transcript for a tab with no logs', () => {
		const result = findTabTranscript(DOCUMENT, 'agent-1', 'empty');
		if (result.status !== 'ok') throw new Error('expected ok');
		expect(result.entries).toEqual([]);
	});

	it('reports a missing agent or tab', () => {
		expect(findTabTranscript(DOCUMENT, 'nobody', 'tab-1')).toEqual({
			status: 'agent-not-found',
			agentId: 'nobody',
		});
		const missingTab = findTabTranscript(DOCUMENT, 'agent-1', 'gone');
		expect(missingTab.status).toBe('tab-not-found');
	});

	it('names every source the desktop writes', () => {
		expect([...LOG_ENTRY_SOURCES].sort()).toEqual(
			['ai', 'error', 'stderr', 'stdout', 'system', 'thinking', 'tool', 'user'].sort()
		);
	});
});

describe('sliceTranscript', () => {
	const entries: LogEntryRecord[] = [10, 20, 30, 40].map((timestamp) => ({
		id: `e${timestamp}`,
		timestamp,
		source: 'ai',
		text: `t${timestamp}`,
	}));
	const ids = (list: LogEntryRecord[]) => list.map((entry) => entry.id);

	it('returns everything with no window', () => {
		expect(ids(sliceTranscript(entries))).toEqual(['e10', 'e20', 'e30', 'e40']);
	});

	it('keeps only entries after sinceMs, exclusive', () => {
		expect(ids(sliceTranscript(entries, { sinceMs: 20 }))).toEqual(['e30', 'e40']);
	});

	it('keeps the newest tail entries, and none for tail 0', () => {
		expect(ids(sliceTranscript(entries, { tail: 2 }))).toEqual(['e30', 'e40']);
		expect(sliceTranscript(entries, { tail: 0 })).toEqual([]);
	});

	it('applies sinceMs before tail', () => {
		expect(ids(sliceTranscript(entries, { sinceMs: 10, tail: 2 }))).toEqual(['e30', 'e40']);
		expect(ids(sliceTranscript(entries, { sinceMs: 30, tail: 5 }))).toEqual(['e40']);
	});
});
