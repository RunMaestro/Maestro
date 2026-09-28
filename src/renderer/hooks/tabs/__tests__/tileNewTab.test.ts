/**
 * Tests for tileNewTab.ts - create a tab and drop it straight into a tile.
 *
 * The two branches that matter are "nothing tiled yet" (a fresh group is built
 * around the on-screen tab) and "a group is already showing" (the FOCUSED pane
 * is split, not the whole grid). Beyond that, the thing worth guarding is that
 * the new tab is minted non-activating: every standard new-tab path clears
 * activeGroupId, which would tear down the group being built.
 */

import { describe, it, expect } from 'vitest';
import type { AITab, Session, TabGroup, UnifiedTabRef } from '../../../types';
import { collectLeafTabRefs, createGroupFromTabRefs, tabRefKey } from '../../../utils/panelLayout';
import { canTileNewTab, tileNewTab } from '../tileNewTab';

const DEFAULTS = { saveToHistory: true, showThinking: 'off' as const };

const aiTab = (id: string): AITab =>
	({ id, name: `Chat ${id}`, logs: [], aiTabs: undefined }) as unknown as AITab;

function baseSession(extra?: Partial<Session>): Session {
	return {
		id: 'sess-1',
		aiTabs: [aiTab('ai-1')],
		activeTabId: 'ai-1',
		filePreviewTabs: [],
		terminalTabs: [],
		browserTabs: [],
		activeFileTabId: null,
		activeBrowserTabId: null,
		activeTerminalTabId: null,
		inputMode: 'ai',
		tabGroups: [],
		activeGroupId: null,
		unifiedTabOrder: [{ type: 'ai', id: 'ai-1' }],
		...extra,
	} as unknown as Session;
}

/** An agent with no tabs at all - nothing on screen to tile against. */
function emptySession(): Session {
	return baseSession({ aiTabs: [], activeTabId: undefined, unifiedTabOrder: [] });
}

/** The single group the result session ended up with. */
function onlyGroup(session: Session): TabGroup {
	expect(session.tabGroups).toHaveLength(1);
	return session.tabGroups[0];
}

describe('canTileNewTab', () => {
	it('is false with no session and true when a tab is on screen', () => {
		expect(canTileNewTab(undefined)).toBe(false);
		expect(canTileNewTab(baseSession())).toBe(true);
	});

	it('is false for an agent with no tabs at all', () => {
		expect(canTileNewTab(emptySession())).toBe(false);
	});
});

describe('tileNewTab - no group yet', () => {
	it('pairs the on-screen tab with the new one in a column, new tab below', () => {
		const result = tileNewTab(baseSession(), 'ai', DEFAULTS);
		if (!result) throw new Error('expected a result');

		const group = onlyGroup(result.session);
		expect(group.layout.kind).toBe('split');
		if (group.layout.kind !== 'split') throw new Error('expected split');
		// 'bottom' is the default zone: a column split with the new pane second.
		expect(group.layout.direction).toBe('column');
		expect(collectLeafTabRefs(group.layout)).toEqual([{ type: 'ai', id: 'ai-1' }, result.ref]);
		expect(group.layout.sizes).toEqual([0.5, 0.5]);
	});

	it('focuses the new pane and activates the group', () => {
		const result = tileNewTab(baseSession(), 'ai', DEFAULTS);
		if (!result) throw new Error('expected a result');

		const group = onlyGroup(result.session);
		expect(result.session.activeGroupId).toBe(group.id);
		const focused = (group.layout.kind === 'split' ? group.layout.children : []).find(
			(c) => c.id === group.focusedPaneId
		);
		expect(focused && focused.kind === 'leaf' && tabRefKey(focused.tab)).toBe(
			tabRefKey(result.ref)
		);
	});

	it('replaces both members with the group chip in the tab strip', () => {
		const result = tileNewTab(baseSession(), 'terminal', DEFAULTS);
		if (!result) throw new Error('expected a result');

		const group = onlyGroup(result.session);
		expect(result.session.unifiedTabOrder).toEqual([{ type: 'group', id: group.id }]);
	});

	it('does not steal the single view: no activeTerminalTabId for a tiled terminal', () => {
		const result = tileNewTab(baseSession(), 'terminal', DEFAULTS);
		if (!result) throw new Error('expected a result');

		expect(result.session.terminalTabs).toHaveLength(1);
		expect(result.session.activeTerminalTabId).toBeNull();
		expect(result.session.inputMode).toBe('ai');
	});

	it('creates a blank Untitled file tab in edit mode', () => {
		const result = tileNewTab(baseSession(), 'file', DEFAULTS);
		if (!result) throw new Error('expected a result');

		expect(result.session.filePreviewTabs).toHaveLength(1);
		expect(result.session.filePreviewTabs[0]).toMatchObject({
			name: 'Untitled',
			path: '',
			editMode: true,
		});
		// The tab must not take over the single view - the group owns the panel.
		expect(result.session.activeFileTabId).toBeNull();
	});

	it('creates a browser tab at the configured home url', () => {
		const result = tileNewTab(baseSession(), 'browser', {
			...DEFAULTS,
			browserHomeUrl: 'https://example.com',
		});
		if (!result) throw new Error('expected a result');

		expect(result.session.browserTabs).toHaveLength(1);
		expect(result.session.browserTabs?.[0].url).toBe('https://example.com');
		expect(result.session.activeBrowserTabId).toBeNull();
	});

	it('returns null when there is nothing on screen to tile against', () => {
		expect(tileNewTab(emptySession(), 'ai', DEFAULTS)).toBeNull();
	});

	it('honors a non-default zone', () => {
		const result = tileNewTab(baseSession(), 'ai', DEFAULTS, 'right');
		if (!result) throw new Error('expected a result');

		const group = onlyGroup(result.session);
		if (group.layout.kind !== 'split') throw new Error('expected split');
		expect(group.layout.direction).toBe('row');
		expect(collectLeafTabRefs(group.layout)).toEqual([{ type: 'ai', id: 'ai-1' }, result.ref]);
	});
});

describe('tileNewTab - existing group', () => {
	/** A live two-pane group whose SECOND pane is focused. */
	function sessionWithGroup(): { session: Session; group: TabGroup; focusedRef: UnifiedTabRef } {
		const refs: UnifiedTabRef[] = [
			{ type: 'ai', id: 'ai-1' },
			{ type: 'ai', id: 'ai-2' },
		];
		const group = createGroupFromTabRefs(refs, 'Group: Chat');
		if (group.layout.kind !== 'split') throw new Error('expected split');
		const secondLeafId = group.layout.children[1].id;
		const focusedGroup: TabGroup = { ...group, focusedPaneId: secondLeafId };
		const session = baseSession({
			aiTabs: [aiTab('ai-1'), aiTab('ai-2')],
			tabGroups: [focusedGroup],
			activeGroupId: focusedGroup.id,
			unifiedTabOrder: [{ type: 'group', id: focusedGroup.id }],
		});
		return { session, group: focusedGroup, focusedRef: refs[1] };
	}

	it('splits the FOCUSED pane, not the whole grid', () => {
		const { session, focusedRef } = sessionWithGroup();
		const result = tileNewTab(session, 'terminal', DEFAULTS);
		if (!result) throw new Error('expected a result');

		const group = onlyGroup(result.session);
		if (group.layout.kind !== 'split') throw new Error('expected split');
		// The top-level row keeps two children; the focused one became a column.
		expect(group.layout.direction).toBe('row');
		expect(group.layout.children).toHaveLength(2);
		const split = group.layout.children[1];
		expect(split.kind).toBe('split');
		if (split.kind !== 'split') throw new Error('expected nested split');
		expect(split.direction).toBe('column');
		expect(collectLeafTabRefs(split)).toEqual([focusedRef, result.ref]);
	});

	it('keeps the group active, focuses the new pane, and adds no strip entry', () => {
		const { session } = sessionWithGroup();
		const before = session.unifiedTabOrder;
		const result = tileNewTab(session, 'ai', DEFAULTS);
		if (!result) throw new Error('expected a result');

		const group = onlyGroup(result.session);
		expect(result.session.activeGroupId).toBe(group.id);
		expect(result.session.unifiedTabOrder).toEqual(before);
		expect(collectLeafTabRefs(group.layout)).toHaveLength(3);
	});

	it('falls back to the first pane when focus is stale', () => {
		const { session, group } = sessionWithGroup();
		const stale: Session = {
			...session,
			tabGroups: [{ ...group, focusedPaneId: 'gone' }],
		};
		const result = tileNewTab(stale, 'ai', DEFAULTS);
		if (!result) throw new Error('expected a result');

		const next = onlyGroup(result.session);
		if (next.layout.kind !== 'split') throw new Error('expected split');
		const first = next.layout.children[0];
		expect(first.kind).toBe('split');
		if (first.kind !== 'split') throw new Error('expected nested split');
		expect(collectLeafTabRefs(first)).toEqual([{ type: 'ai', id: 'ai-1' }, result.ref]);
	});
});
