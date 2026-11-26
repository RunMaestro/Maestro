/**
 * @fileoverview A closed-tab stack read off the wire from another machine (G5): only well-formed
 * entries, each bounded, at most as many as a stack here keeps, re-indexed in order.
 */

import { describe, expect, it } from 'vitest';
import {
	MAX_CLOSED_TAB_HISTORY,
	MAX_WIRE_CLOSED_TAB_LABEL,
	parseWireClosedTabs,
} from '../../shared/closedTabHistory';

describe('parseWireClosedTabs', () => {
	it('keeps well-formed entries, re-indexed, with only their known fields', () => {
		expect(
			parseWireClosedTabs([
				{
					index: 9,
					type: 'ai',
					label: 'Tax',
					tabId: 't1',
					closedAt: 5,
					agentSessionId: 's1',
					x: 1,
				},
				null,
				{ type: 'ai', tabId: '' },
				{ type: 'shell', tabId: 't2' },
				{ index: 3, type: 'file', label: 7, tabId: 't3', closedAt: 'soon', tiled: true },
			])
		).toEqual([
			{ index: 0, type: 'ai', label: 'Tax', tabId: 't1', closedAt: 5, agentSessionId: 's1' },
			{ index: 1, type: 'file', label: '', tabId: 't3', closedAt: 0, tiled: true },
		]);
	});

	it('bounds the count and the label, and reads a non-list as empty', () => {
		const many = Array.from({ length: 100 }, (_, i) => ({
			type: 'ai',
			tabId: `t${i}`,
			label: 'x'.repeat(5000),
			closedAt: i,
		}));
		const parsed = parseWireClosedTabs(many);
		expect(parsed).toHaveLength(MAX_CLOSED_TAB_HISTORY);
		expect(parsed[0].label).toHaveLength(MAX_WIRE_CLOSED_TAB_LABEL);
		expect(parseWireClosedTabs({ 0: many[0] })).toEqual([]);
		expect(parseWireClosedTabs(undefined)).toEqual([]);
	});
});
