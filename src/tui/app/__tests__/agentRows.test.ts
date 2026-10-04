import { describe, expect, it } from 'vitest';
import { buildAgentTree, type AgentRecord, type GroupRecord } from '../../../shared/maestro-lib';
import {
	buildPaneRows,
	initialCursorKey,
	isSectionCollapsed,
	moveCursor,
	providerBadge,
	stateColor,
	windowRows,
} from '../agentRows';

const agent = (id: string, name: string, extra: Partial<AgentRecord> = {}): AgentRecord => ({
	id,
	name,
	toolType: 'claude-code',
	...extra,
});
const groups: GroupRecord[] = [
	{ id: 'g1', name: 'Core', collapsed: false },
	{ id: 'g2', name: 'Web', collapsed: true },
];
const sections = buildAgentTree(
	[
		agent('a', 'Alpha', { groupId: 'g1', bookmarked: true }),
		agent('w', 'wt', { parentSessionId: 'a' }),
		agent('b', 'Beta', { groupId: 'g2' }),
	],
	groups
);

describe('buildPaneRows', () => {
	it('lists every section header, folds by the desktop default, and indents worktree children', () => {
		const rows = buildPaneRows(sections, {});
		expect(rows.map((row) => row.key)).toEqual([
			'bookmarks',
			'bookmarks/a',
			'bookmarks/w',
			'group:g1',
			'group:g1/a',
			'group:g1/w',
			'group:g2',
		]);
		const child = rows.find((row) => row.key === 'group:g1/w');
		expect(child?.kind === 'agent' && child.depth).toBe(1);
	});

	it('lets the user override a fold either way and counts hidden agents', () => {
		const rows = buildPaneRows(sections, { 'group:g1': true, 'group:g2': false });
		expect(rows.map((row) => row.key)).toContain('group:g2/b');
		expect(rows.map((row) => row.key)).not.toContain('group:g1/a');
		const folded = rows.find((row) => row.key === 'group:g1');
		expect(folded?.kind === 'section' && folded.agentCount).toBe(2);
		expect(isSectionCollapsed(sections[1], {})).toBe(false);
	});
});

describe('cursor', () => {
	const rows = buildPaneRows(sections, {});

	it('starts on the remembered agent when it is listed, else on the first row', () => {
		expect(initialCursorKey(rows, 'b')).toBe('bookmarks');
		expect(initialCursorKey(rows, 'a')).toBe('bookmarks/a');
		expect(initialCursorKey(rows, 'gone')).toBe('bookmarks');
		expect(initialCursorKey([], 'a')).toBeUndefined();
	});

	it('moves by rows and stops at both ends', () => {
		expect(moveCursor(rows, 'bookmarks', 1)).toBe('bookmarks/a');
		expect(moveCursor(rows, 'bookmarks', -1)).toBe('bookmarks');
		expect(moveCursor(rows, 'group:g2', 1)).toBe('group:g2');
		expect(moveCursor(rows, undefined, 1)).toBe('bookmarks/a');
		expect(moveCursor([], 'x', 1)).toBeUndefined();
	});
});

describe('windowRows', () => {
	const rows = Array.from({ length: 20 }, (_, i) => ({ key: `r${i}` }));

	it('returns everything when it fits', () => {
		expect(windowRows(rows.slice(0, 3), 'r1', 5).rows).toHaveLength(3);
	});

	it('scrolls only as far as needed to keep the cursor on screen', () => {
		expect(windowRows(rows, 'r2', 5, 0).start).toBe(0);
		expect(windowRows(rows, 'r7', 5, 0).start).toBe(3);
		expect(windowRows(rows, 'r7', 5, 3).start).toBe(3);
		expect(windowRows(rows, 'r1', 5, 3).start).toBe(1);
		expect(windowRows(rows, 'r19', 5, 0).rows.map((row) => row.key)).toEqual([
			'r15',
			'r16',
			'r17',
			'r18',
			'r19',
		]);
	});

	it('draws nothing when there is no height', () => {
		expect(windowRows(rows, 'r0', 0).rows).toEqual([]);
	});
});

describe('row styling', () => {
	it('colors states the way the desktop does', () => {
		expect(stateColor('idle')).toBe('green');
		expect(stateColor(undefined)).toBe('green');
		expect(stateColor('busy')).toBe('yellow');
		expect(stateColor('error')).toBe('red');
		expect(stateColor('connecting')).toBe('#ff9900');
	});

	it('badges a provider with initials or its first letters, and an unknown one by id', () => {
		expect(providerBadge('claude-code')).toBe('CC');
		expect(providerBadge('codex')).toBe('COD');
		expect(providerBadge('omp')).toBe('OMP');
		expect(providerBadge('provider-from-the-future')).toBe('PFT');
	});
});
