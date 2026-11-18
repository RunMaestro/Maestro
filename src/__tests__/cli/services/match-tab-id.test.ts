/**
 * @file match-tab-id.test.ts
 * @description The tab id rules every tab verb shares (`matchTabId`): exact id, then a unique
 * prefix. Used for the desktop's open tabs and for a Federation host's tabs.
 */

import { describe, expect, it } from 'vitest';
import { matchTabId } from '../../../cli/services/session-command';

const tabs = [{ id: 'abc123' }, { id: 'abc999' }, { id: 'def456' }, { id: 'abc' }];
const idOf = (tab: { id: string }) => tab.id;

describe('matchTabId', () => {
	it('prefers an exact id over a prefix it also matches', () => {
		expect(matchTabId(tabs, 'abc', idOf)).toEqual({ id: 'abc' });
	});

	it('takes a unique prefix', () => {
		expect(matchTabId(tabs, 'def', idOf)).toEqual({ id: 'def456' });
		expect(matchTabId(tabs, 'abc1', idOf)).toEqual({ id: 'abc123' });
	});

	it('refuses an ambiguous prefix and an unknown id', () => {
		const shared = [{ id: 'abc123' }, { id: 'abc999' }];
		expect(() => matchTabId(shared, 'abc', idOf)).toThrow("Ambiguous tab ID 'abc' (2 matches)");
		expect(() => matchTabId(tabs, 'zzz', idOf)).toThrow('Tab not found: zzz');
	});
});
