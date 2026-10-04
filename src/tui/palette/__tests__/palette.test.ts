import { describe, expect, it } from 'vitest';
import type { Key } from 'ink';
import type { AgentRecord } from '../../../shared/maestro-lib';
import { KEYMAP } from '../../keymap';
import { agentMenuEntries } from '../agentMenu';
import { buildPaletteEntries } from '../entries';
import { highlightSegments, rankPaletteEntries } from '../rank';
import {
	EMPTY_PALETTE,
	backspacePalette,
	isPaletteBackspace,
	movePaletteCursor,
	paletteTextFor,
	typeIntoPalette,
} from '../state';

const NO_KEY: Key = {
	upArrow: false,
	downArrow: false,
	leftArrow: false,
	rightArrow: false,
	pageDown: false,
	pageUp: false,
	return: false,
	escape: false,
	ctrl: false,
	shift: false,
	tab: false,
	backspace: false,
	delete: false,
	meta: false,
};

const AGENTS = [
	{
		id: 'a1',
		name: 'Maestro',
		toolType: 'claude-code',
		aiTabs: [
			{ id: 't1', name: 'lib-audit' },
			{ id: 't2', name: 'ghost', hidden: true },
		],
	},
	{ id: 'a2', name: 'Cue', toolType: 'codex' },
	{ id: 'a3', name: 'History Keeper', toolType: 'opencode' },
] as unknown as AgentRecord[];

describe('palette entries', () => {
	const entries = buildPaletteEntries(AGENTS);

	it('lists every action in the keymap, with its keys', () => {
		for (const binding of KEYMAP) {
			const entry = entries.find((candidate) => candidate.id === `action:${binding.action}`);
			expect(entry, binding.action).toBeDefined();
			expect(entry?.label).toBe(binding.description);
			expect(entry?.target).toEqual({ kind: 'action', action: binding.action });
		}
		expect(entries.find((entry) => entry.id === 'action:palette')?.detail).toBe('Ctrl-K');
	});

	it('lists agents by name with their provider, then visible tabs under the agent name', () => {
		const agent = entries.find((entry) => entry.id === 'agent:a1');
		expect(agent).toMatchObject({ label: 'Maestro', detail: 'Claude Code' });
		const tabs = entries.filter((entry) => entry.target.kind === 'tab');
		expect(tabs.map((tab) => tab.label)).toEqual(['Maestro / lib-audit']);
		expect(tabs[0].target).toEqual({ kind: 'tab', agentId: 'a1', tabId: 't1' });
	});

	it('orders actions, then agents, then tabs, and gives one row to an agent listed twice', () => {
		const kinds = buildPaletteEntries([...AGENTS, AGENTS[0]]).map((entry) => entry.target.kind);
		expect(kinds.indexOf('agent')).toBeGreaterThan(kinds.lastIndexOf('action'));
		expect(kinds.indexOf('tab')).toBeGreaterThan(kinds.lastIndexOf('agent'));
		expect(kinds.filter((kind) => kind === 'agent')).toHaveLength(3);
		expect(kinds.filter((kind) => kind === 'tab')).toHaveLength(1);
	});
});

describe('palette ranking', () => {
	const entries = buildPaletteEntries(AGENTS);
	const labels = (query: string) => rankPaletteEntries(entries, query).map((r) => r.entry.label);

	it('keeps everything, in order, for an empty query', () => {
		const ranked = rankPaletteEntries(entries, '  ');
		expect(ranked.map((r) => r.entry)).toEqual(entries);
		expect(ranked.every((r) => r.indices.length === 0)).toBe(true);
	});

	it('drops what the query does not match', () => {
		expect(labels('zzzz')).toEqual([]);
		expect(labels('cue')).toContain('Cue');
		expect(labels('cue')).not.toContain('Maestro');
	});

	it('ranks a prefix above a scattered match', () => {
		const ranked = labels('hist');
		expect(ranked[0]).toBe('History Keeper');
		expect(ranked).toContain('History of the selected agent');
	});

	it('puts a whole-word match on an action above a fuzzy one elsewhere', () => {
		expect(labels('quit')[0]).toBe('Quit');
		expect(labels('palette')[0]).toBe('Command palette');
	});

	it('finds a tab by agent and tab name together', () => {
		expect(labels('maelib')[0]).toBe('Maestro / lib-audit');
	});

	it('breaks a tie by the order given, so the list does not shuffle', () => {
		const twins = buildPaletteEntries([
			{ id: 'x1', name: 'Twin', toolType: 'codex' },
			{ id: 'x2', name: 'Twin', toolType: 'codex' },
		] as unknown as AgentRecord[]);
		const ids = rankPaletteEntries(twins, 'twin')
			.map((r) => r.entry.id)
			.filter((id) => id.startsWith('agent:'));
		expect(ids).toEqual(['agent:x1', 'agent:x2']);
	});

	it('reports which characters matched, and splits them into runs', () => {
		const [first] = rankPaletteEntries(entries, 'cue');
		expect(first.entry.label).toBe('Cue');
		expect(first.indices).toEqual([0, 1, 2]);
		expect(highlightSegments('Quit', [0, 1])).toEqual([
			{ text: 'Qu', match: true },
			{ text: 'it', match: false },
		]);
		expect(highlightSegments('Quit', [])).toEqual([{ text: 'Quit', match: false }]);
	});
});

describe('palette state', () => {
	it('types, deletes, and sends the cursor back to the best match', () => {
		let state = movePaletteCursor({ ...EMPTY_PALETTE, query: 'a' }, 2, 5);
		expect(state.cursor).toBe(2);
		state = typeIntoPalette(state, 'bc');
		expect(state).toEqual({ query: 'abc', cursor: 0 });
		expect(backspacePalette(state)).toEqual({ query: 'ab', cursor: 0 });
		expect(backspacePalette(EMPTY_PALETTE)).toBe(EMPTY_PALETTE);
		expect(typeIntoPalette(EMPTY_PALETTE, '')).toBe(EMPTY_PALETTE);
	});

	it('clamps the cursor to the results', () => {
		const state = { query: '', cursor: 1 };
		expect(movePaletteCursor(state, 5, 3).cursor).toBe(2);
		expect(movePaletteCursor(state, -5, 3).cursor).toBe(0);
		expect(movePaletteCursor(state, 1, 0).cursor).toBe(0);
		expect(movePaletteCursor({ query: '', cursor: 2 }, 1, 3)).toEqual({ query: '', cursor: 2 });
	});

	it('takes printable text, drops control characters, and ignores Ctrl and Meta chords', () => {
		expect(paletteTextFor('j', NO_KEY)).toBe('j');
		expect(paletteTextFor('a b\t', NO_KEY)).toBe('a b');
		expect(paletteTextFor('\u001b', NO_KEY)).toBe('');
		expect(paletteTextFor('x', { ...NO_KEY, ctrl: true })).toBe('');
		expect(paletteTextFor('x', { ...NO_KEY, meta: true })).toBe('');
	});

	it('reads either flag a terminal sets for Backspace', () => {
		expect(isPaletteBackspace({ ...NO_KEY, backspace: true })).toBe(true);
		expect(isPaletteBackspace({ ...NO_KEY, delete: true })).toBe(true);
		expect(isPaletteBackspace(NO_KEY)).toBe(false);
	});
});

describe('agent menu', () => {
	it('lists every binding that declares an agent menu label, with its keys', () => {
		const entries = agentMenuEntries();
		expect(entries.map((entry) => entry.action)).toEqual(
			KEYMAP.filter((binding) => binding.agentMenu).map((binding) => binding.action)
		);
		expect(entries).toContainEqual({ action: 'history', label: 'History', keys: 'H' });
		expect(entries).toContainEqual({ action: 'tabSwitcher', label: 'Switch tab', keys: 'T' });
	});
});
