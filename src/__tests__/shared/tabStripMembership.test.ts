import { describe, expect, it } from 'vitest';
import {
	collectGroupMemberTabKeys,
	countOpenTabs,
	countTabStrip,
	dropOrphanedTabs,
	tabStripSlotKeys,
	tabStripVisibility,
} from '../../shared/tabStripMembership';

const agent = () => ({
	aiTabs: [{ id: 'open' }, { id: 'consult', hidden: true }, { id: 'closed' }, { id: 'tiled-ai' }],
	filePreviewTabs: [{ id: 'file' }],
	browserTabs: [{ id: 'web' }],
	terminalTabs: [{ id: 'term' }, { id: 'stale-term' }],
	unifiedTabOrder: [
		{ type: 'ai', id: 'open' },
		{ type: 'ai', id: 'consult' },
		{ type: 'file', id: 'file' },
		{ type: 'browser', id: 'web' },
		{ type: 'group', id: 'g1' },
	],
	tabGroups: [
		{
			id: 'g1',
			layout: {
				kind: 'split',
				id: 's1',
				children: [
					{ kind: 'leaf', id: 'l1', tab: { type: 'ai', id: 'tiled-ai' } },
					{ kind: 'leaf', id: 'l2', tab: { type: 'terminal', id: 'term' } },
				],
			},
		},
	],
});

describe('tabStripMembership', () => {
	it('collects the leaves of every tiled group', () => {
		expect([...collectGroupMemberTabKeys(agent())].sort()).toEqual([
			'ai:tiled-ai',
			'terminal:term',
		]);
		expect(collectGroupMemberTabKeys({ tabGroups: [null, { layout: {} }] }).size).toBe(0);
	});

	it('classifies each tab as visible, hidden, or orphaned', () => {
		const session = agent();
		const slots = tabStripSlotKeys(session);
		const byId = (type: 'ai' | 'terminal', id: string) =>
			tabStripVisibility(type, { id, hidden: id === 'consult' }, slots);
		expect(byId('ai', 'open')).toBe('visible');
		expect(byId('ai', 'consult')).toBe('hidden');
		expect(byId('ai', 'closed')).toBe('orphaned');
		expect(byId('ai', 'tiled-ai')).toBe('visible');
		expect(byId('terminal', 'stale-term')).toBe('orphaned');
	});

	it('treats a legacy record with no order as fully visible', () => {
		expect(tabStripSlotKeys({ aiTabs: [{ id: 'a' }] })).toBeNull();
		expect(tabStripVisibility('ai', { id: 'a' }, null)).toBe('visible');
		expect(tabStripVisibility('ai', { id: 'a', hidden: true }, null)).toBe('hidden');
	});

	it('counts by kind and visibility, and counts open tabs as the visible ones', () => {
		expect(countTabStrip(agent())).toEqual({
			ai: { visible: 2, hidden: 1, orphaned: 1 },
			file: { visible: 1, hidden: 0, orphaned: 0 },
			browser: { visible: 1, hidden: 0, orphaned: 0 },
			terminal: { visible: 1, hidden: 0, orphaned: 1 },
		});
		expect(countOpenTabs(agent())).toBe(5);
		expect(countOpenTabs({})).toBe(0);
	});

	it('drops orphans, keeps hidden tabs, and returns the same reference when clean', () => {
		const { session, dropped } = dropOrphanedTabs(agent());
		expect(dropped).toBe(2);
		expect(session.aiTabs.map((tab) => tab.id)).toEqual(['open', 'consult', 'tiled-ai']);
		expect(session.terminalTabs).toEqual([{ id: 'term' }]);

		const again = dropOrphanedTabs(session);
		expect(again.session).toBe(session);
		expect(again.dropped).toBe(0);

		const hiddenOutsideOrder = { aiTabs: [{ id: 'qc', hidden: true }], unifiedTabOrder: [] };
		expect(dropOrphanedTabs(hiddenOutsideOrder).session).toBe(hiddenOutsideOrder);
	});
});
