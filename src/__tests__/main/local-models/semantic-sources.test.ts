/**
 * @file semantic-sources.test.ts
 *
 * The semantic index's source readers: what counts as indexable text in
 * History, the Director's Notes archive, and persisted AI tab transcripts.
 * Pure functions over plain records; nothing here embeds or touches disk.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	TRANSCRIPT_SETTLE_MS,
	createDirectorNotesReader,
	createHistoryReader,
	createTranscriptReader,
	historyEntryItem,
	historyEntryText,
	historyGroupEntries,
	historySessionIds,
	synopsisItem,
	transcriptItems,
	type SemanticSourceItem,
	type SemanticSourceReader,
} from '../../../main/local-models/semantic-sources';
import {
	parseTranscriptSourceId,
	transcriptSourceId,
} from '../../../shared/local-models/embedding-index';
import type { HistoryEntry } from '../../../shared/types';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		id: 'entry-1',
		type: 'USER',
		timestamp: 1_000,
		summary: 'Fixed the login timeout',
		projectPath: '/project',
		...overrides,
	};
}

async function readAll(reader: SemanticSourceReader): Promise<SemanticSourceItem[]> {
	const items: SemanticSourceItem[] = [];
	for (const group of await reader.groups()) items.push(...(await group.load()));
	return items;
}

describe('historyEntryText', () => {
	it('leads with the summary and follows with the full response', () => {
		expect(historyEntryText({ summary: 'Fixed login', fullResponse: 'The token expired.' })).toBe(
			'Fixed login\n\nThe token expired.'
		);
	});

	it('does not repeat a summary the response already opens with', () => {
		expect(
			historyEntryText({ summary: 'Fixed login', fullResponse: 'Fixed login by renewing.' })
		).toBe('Fixed login by renewing.');
		expect(historyEntryText({ summary: 'Fixed login', fullResponse: 'Fixed login' })).toBe(
			'Fixed login'
		);
	});

	it('uses whichever half exists', () => {
		expect(historyEntryText({ summary: 'Only a summary' })).toBe('Only a summary');
		expect(historyEntryText({ summary: '', fullResponse: 'Only a response' })).toBe(
			'Only a response'
		);
		expect(historyEntryText({ summary: '  ', fullResponse: ' ' })).toBe('');
	});
});

describe('historyEntryItem', () => {
	it('indexes user, Auto Run, and consult entries by default', () => {
		for (const type of ['USER', 'AUTO', 'AGENT'] as const) {
			expect(historyEntryItem(entry({ type }), 'agent-a', false)).toEqual({
				sourceType: 'history',
				sourceId: 'entry-1',
				agentId: 'agent-a',
				text: 'Fixed the login timeout',
				mutable: false,
			});
		}
	});

	it('skips a Cue run unless Cue indexing is on', () => {
		const cue = entry({ type: 'CUE', summary: 'lint-on-save ran' });
		expect(historyEntryItem(cue, 'agent-a', false)).toBeNull();
		expect(historyEntryItem(cue, 'agent-a', true)).toMatchObject({ sourceId: 'entry-1' });
	});

	it('skips an entry with no id or no text', () => {
		expect(historyEntryItem(entry({ id: '' }), 'agent-a', true)).toBeNull();
		expect(historyEntryItem(entry({ summary: ' ' }), 'agent-a', true)).toBeNull();
	});
});

describe('createHistoryReader', () => {
	const stored: Record<string, HistoryEntry[]> = {
		'agent-a': [
			entry({ id: 'a-user' }),
			entry({ id: 'a-cue', type: 'CUE', summary: 'cue ran' }),
			entry({ id: 'a-auto', type: 'AUTO', summary: 'Auto Run task' }),
		],
		'agent-b': [entry({ id: 'b-user' })],
	};
	const base = {
		listSessions: async () => Object.keys(stored),
		getEntries: async (sessionId: string) => stored[sessionId] ?? [],
	};

	it('reads one group per agent and leaves Cue runs out by default', async () => {
		const reader = createHistoryReader({ ...base, includeCue: () => false });
		expect((await reader.groups()).map((group) => group.key)).toEqual(['agent-a', 'agent-b']);

		const items = await readAll(reader);
		expect(items.map((item) => item.sourceId)).toEqual(['a-user', 'a-auto', 'b-user']);
		expect(items.every((item) => item.sourceType === 'history' && !item.mutable)).toBe(true);
		expect(items[0].agentId).toBe('agent-a');
	});

	it('includes Cue runs when the setting is on, read at each pass', async () => {
		let includeCue = false;
		const reader = createHistoryReader({ ...base, includeCue: () => includeCue });
		expect((await readAll(reader)).map((item) => item.sourceId)).not.toContain('a-cue');
		includeCue = true;
		expect((await readAll(reader)).map((item) => item.sourceId)).toContain('a-cue');
	});

	it('adds Cue database runs, and agents that have only those, when Cue indexing is on', async () => {
		const cueRuns = {
			sessions: vi.fn(() => ['agent-a', 'agent-cue-only']),
			entries: vi.fn((sessionId: string) => [
				entry({ id: `${sessionId}-run`, type: 'CUE', summary: 'nightly sweep finished' }),
			]),
		};
		const reader = createHistoryReader({ ...base, includeCue: () => true, cueRuns });

		expect((await reader.groups()).map((group) => group.key)).toEqual([
			'agent-a',
			'agent-b',
			'agent-cue-only',
		]);
		const ids = (await readAll(reader)).map((item) => item.sourceId);
		expect(ids).toContain('agent-a-run');
		expect(ids).toContain('agent-cue-only-run');
		// The stored entries are handed over, so the caller can drop duplicates.
		expect(cueRuns.entries).toHaveBeenCalledWith('agent-a', stored['agent-a']);
	});

	it('never asks the Cue database while Cue indexing is off', async () => {
		const cueRuns = { sessions: vi.fn(() => ['agent-x']), entries: vi.fn(() => []) };
		const reader = createHistoryReader({ ...base, includeCue: () => false, cueRuns });
		await readAll(reader);
		expect(cueRuns.sessions).not.toHaveBeenCalled();
		expect(cueRuns.entries).not.toHaveBeenCalled();
	});

	it('lists an entry id once even when two stores carry it', async () => {
		const cueRuns = {
			sessions: () => [],
			entries: (sessionId: string) =>
				sessionId === 'agent-a' ? [entry({ id: 'a-cue', type: 'CUE', summary: 'cue ran' })] : [],
		};
		const reader = createHistoryReader({ ...base, includeCue: () => true, cueRuns });
		const ids = (await readAll(reader)).map((item) => item.sourceId);
		expect(ids.filter((id) => id === 'a-cue')).toHaveLength(1);
	});

	it('hands the search the same entries, each paired with its index item', async () => {
		const deps = { ...base, includeCue: () => false };
		expect(await historySessionIds(deps)).toEqual(['agent-a', 'agent-b']);

		const pairs = await historyGroupEntries(deps, 'agent-a');
		// The Cue run is left out here exactly as the reader leaves it out.
		expect(pairs.map((pair) => pair.entry.id)).toEqual(['a-user', 'a-auto']);
		expect(pairs[1].entry).toBe(stored['agent-a'][2]);
		expect(pairs[1].item).toEqual({
			sourceType: 'history',
			sourceId: 'a-auto',
			agentId: 'agent-a',
			text: 'Auto Run task',
			mutable: false,
		});

		const reader = createHistoryReader(deps);
		const group = (await reader.groups()).find((candidate) => candidate.key === 'agent-a')!;
		expect(await group.load()).toEqual(pairs.map((pair) => pair.item));
	});
});

describe("Director's Notes", () => {
	const record = {
		id: 'notes-1',
		generatedAt: 5,
		lookbackDays: 7,
		text: '## Shipped\n- login fix',
	};

	it('indexes an archived synopsis as one immutable source with no agent', () => {
		expect(synopsisItem(record)).toEqual({
			sourceType: 'directors-notes',
			sourceId: 'notes-1',
			agentId: null,
			text: '## Shipped\n- login fix',
			mutable: false,
		});
		expect(synopsisItem({ ...record, text: '  ' })).toBeNull();
	});

	it('reads the archive as one group', async () => {
		const reader = createDirectorNotesReader(async () => [record, { ...record, id: 'notes-2' }]);
		expect(await reader.groups()).toHaveLength(1);
		expect((await readAll(reader)).map((item) => item.sourceId)).toEqual(['notes-1', 'notes-2']);
	});
});

describe('transcriptItems', () => {
	const NOW = 10 * 60_000;
	const OLD = NOW - TRANSCRIPT_SETTLE_MS - 1;

	function log(id: string, source: string, text: string, timestamp = OLD, extra = {}) {
		return { id, timestamp, source, text, ...extra };
	}

	function session(tabs: unknown[]): Record<string, unknown> {
		return { id: 'agent-a', aiTabs: tabs };
	}

	it('makes one source per turn: the user message and what was answered', () => {
		const items = transcriptItems(
			session([
				{
					id: 'tab-1',
					logs: [
						log('m1', 'user', 'How do I rename a tab?'),
						log('m2', 'ai', 'Press the rename shortcut.'),
						log('m3', 'user', 'And close it?'),
						log('m4', 'stdout', 'Use the close button.'),
					],
				},
			]),
			NOW
		);

		expect(items).toEqual([
			{
				sourceType: 'transcript',
				sourceId: transcriptSourceId('tab-1', 'm1'),
				agentId: 'agent-a',
				text: 'How do I rename a tab?\n\nPress the rename shortcut.',
				mutable: false,
			},
			{
				sourceType: 'transcript',
				sourceId: transcriptSourceId('tab-1', 'm3'),
				agentId: 'agent-a',
				text: 'And close it?\n\nUse the close button.',
				mutable: true,
			},
		]);
		expect(parseTranscriptSourceId(items[1].sourceId)).toEqual({ tabId: 'tab-1', turnId: 'm3' });
	});

	it('leaves out thinking, tool calls, system and error entries', () => {
		const [item] = transcriptItems(
			session([
				{
					id: 'tab-1',
					logs: [
						log('m1', 'user', 'Run the tests'),
						log('m2', 'thinking', 'I should run vitest'),
						log('m3', 'tool', 'Bash: npx vitest'),
						log('m4', 'stdout', 'tool card', OLD, { metadata: { toolState: { status: 'ok' } } }),
						log('m5', 'ai', 'collapsed', OLD, { metadata: { hiddenProgress: { kind: 'tool' } } }),
						log('m6', 'system', 'Context compacted'),
						log('m7', 'error', 'Rate limited'),
						log('m8', 'ai', 'All 12 tests pass.'),
					],
				},
			]),
			NOW
		);
		expect(item.text).toBe('Run the tests\n\nAll 12 tests pass.');
	});

	it('waits for the newest turn to go quiet, counting tool activity as noise', () => {
		const streaming = session([
			{
				id: 'tab-1',
				logs: [
					log('m1', 'user', 'First question'),
					log('m2', 'ai', 'First answer'),
					log('m3', 'user', 'Second question'),
					log('m4', 'ai', 'Partial ans'),
					// A tool call a moment ago: the turn is still running.
					log('m5', 'tool', 'Bash: sleep', NOW - 1_000),
				],
			},
		]);
		expect(transcriptItems(streaming, NOW).map((item) => item.sourceId)).toEqual([
			transcriptSourceId('tab-1', 'm1'),
		]);
		// Once it has been quiet long enough, the turn appears, still mutable.
		const later = transcriptItems(streaming, NOW + TRANSCRIPT_SETTLE_MS);
		expect(later).toHaveLength(2);
		expect(later[1]).toMatchObject({ sourceId: transcriptSourceId('tab-1', 'm3'), mutable: true });
	});

	it('anchors the leftover of a turn whose opening fell out of the window', () => {
		const items = transcriptItems(
			session([
				{
					id: 'tab-1',
					logs: [
						log('m7', 'ai', 'the rest of an older answer'),
						log('m8', 'user', 'Next question'),
						log('m9', 'ai', 'Next answer'),
					],
				},
			]),
			NOW
		);
		expect(items.map((item) => item.sourceId)).toEqual([
			transcriptSourceId('tab-1', 'm7'),
			transcriptSourceId('tab-1', 'm8'),
		]);
		expect(items[0].text).toBe('the rest of an older answer');
	});

	it('never indexes a hidden consult tab', () => {
		const items = transcriptItems(
			session([
				{ id: 'consult', hidden: true, logs: [log('m1', 'user', 'secret consult')] },
				{ id: 'tab-1', logs: [log('m2', 'user', 'visible question')] },
			]),
			NOW
		);
		expect(items.map((item) => item.sourceId)).toEqual([transcriptSourceId('tab-1', 'm2')]);
	});

	it('survives records with no tabs, no logs, or entries with no id', () => {
		expect(transcriptItems({ id: 'agent-a' }, NOW)).toEqual([]);
		expect(transcriptItems({ aiTabs: [] }, NOW)).toEqual([]);
		expect(transcriptItems(session([{ id: 'tab-1' }, null, { logs: [] }]), NOW)).toEqual([]);
		expect(
			transcriptItems(
				session([{ id: 'tab-1', logs: [{ source: 'user', text: 'no id', timestamp: OLD }] }]),
				NOW
			)
		).toEqual([]);
	});
});

describe('createTranscriptReader', () => {
	it('reads one group per agent, from the record as it is at load time', async () => {
		const old = 0;
		let sessions: Array<Record<string, unknown>> = [
			{
				id: 'agent-a',
				aiTabs: [
					{ id: 'tab-1', logs: [{ id: 'm1', source: 'user', text: 'one', timestamp: old }] },
				],
			},
			{ id: 'agent-b', aiTabs: [] },
			{ name: 'no id' },
		];
		const reader = createTranscriptReader({ sessions: () => sessions, now: () => 10 * 60_000 });
		const groups = await reader.groups();
		expect(groups.map((group) => group.key)).toEqual(['agent-a', 'agent-b']);

		// Saved again between listing and loading: the newer record is what loads.
		sessions = [
			{
				id: 'agent-a',
				aiTabs: [
					{ id: 'tab-1', logs: [{ id: 'm1', source: 'user', text: 'two', timestamp: old }] },
				],
			},
		];
		expect((await groups[0].load())[0].text).toBe('two');
		// An agent closed in between loads nothing rather than throwing.
		expect(await groups[1].load()).toEqual([]);
	});
});
