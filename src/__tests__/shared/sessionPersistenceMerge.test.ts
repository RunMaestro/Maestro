import { describe, expect, it } from 'vitest';
import { mergeSessionPersistenceChanges } from '../../shared/sessionPersistenceMerge';

describe('observed session changes', () => {
	it('accepts tab and queue drag order and new-tab insertion without stealing host group focus', () => {
		const baseline = {
			id: 'shared',
			activeGroupId: 'host-group',
			aiTabs: [
				{ id: 'a', inputValue: 'host draft' },
				{ id: 'b', inputValue: '' },
			],
			unifiedTabOrder: [
				{ id: 'a', type: 'ai' },
				{ id: 'b', type: 'ai' },
			],
			executionQueue: [{ id: 'first' }, { id: 'second' }],
		};
		const incoming = {
			...baseline,
			activeGroupId: 'remote-group',
			aiTabs: [{ id: 'new', inputValue: 'remote draft' }, ...[...baseline.aiTabs].reverse()],
			unifiedTabOrder: [{ id: 'new', type: 'ai' }, ...[...baseline.unifiedTabOrder].reverse()],
			executionQueue: [...baseline.executionQueue].reverse(),
		};
		const remote = mergeSessionPersistenceChanges(incoming, baseline, baseline, true);
		expect(remote.aiTabs.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
		expect(remote.unifiedTabOrder.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
		expect(remote.executionQueue.map((item) => item.id)).toEqual(['second', 'first']);
		expect(remote.activeGroupId).toBe('host-group');
		expect(remote.aiTabs[0].inputValue).toBe('');
		expect(remote.aiTabs[2].inputValue).toBe('host draft');
		const desktop = mergeSessionPersistenceChanges(incoming, baseline, baseline);
		expect(desktop.aiTabs.map((tab) => tab.id)).toEqual(['new', 'b', 'a']);
		expect(desktop.activeGroupId).toBe('remote-group');
	});

	it('retains peer-only tabs and does not revive removed tabs during a stale drag', () => {
		const baseline = { aiTabs: [{ id: 'a' }, { id: 'b' }, { id: 'removed' }] };
		const stored = { aiTabs: [{ id: 'a' }, { id: 'peer' }, { id: 'b' }] };
		const incoming = { aiTabs: [{ id: 'new' }, ...[...baseline.aiTabs].reverse()] };
		const merged = mergeSessionPersistenceChanges(incoming, stored, baseline);
		expect(merged.aiTabs.map((tab) => tab.id)).toEqual(['new', 'peer', 'b', 'a']);
	});

	it('keeps the host order when another client already reordered the same queue', () => {
		const baseline = { executionQueue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
		const stored = { executionQueue: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] };
		const incoming = { executionQueue: [...baseline.executionQueue].reverse() };
		expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
			stored.executionQueue
		);
	});

	it('preserves an owning ConPTY terminal with PID zero across stale remote saves and live peer reconciliation', () => {
		const baseline = {
			terminalTabs: [{ id: 'owned', pid: 0, ptyInitialized: true, name: 'Terminal' }],
		};
		const incoming = {
			terminalTabs: [
				{ ...baseline.terminalTabs[0], ptyInitialized: false, name: 'Renamed' },
				{ id: 'new', pid: 0, ptyInitialized: true, name: 'New' },
			],
		};
		const saved = mergeSessionPersistenceChanges(incoming, baseline, baseline, true);
		expect(saved.terminalTabs.find((tab) => tab.id === 'owned')).toMatchObject({
			pid: 0,
			ptyInitialized: true,
			name: 'Renamed',
		});
		expect(saved.terminalTabs.find((tab) => tab.id === 'new')).not.toHaveProperty('ptyInitialized');
		const firstTerminal = mergeSessionPersistenceChanges<{
			terminalTabs?: typeof incoming.terminalTabs;
		}>(incoming, {}, {}, true);
		expect(firstTerminal.terminalTabs?.[0]).not.toHaveProperty('ptyInitialized');
		const live = mergeSessionPersistenceChanges(incoming, baseline, baseline, true, true);
		expect(live.terminalTabs.find((tab) => tab.id === 'owned')).toMatchObject({
			pid: 0,
			ptyInitialized: true,
			name: 'Renamed',
		});
		expect(live.terminalTabs.find((tab) => tab.id === 'new')?.ptyInitialized).toBe(true);
	});

	it('retains live incognito tabs and client focus across persisted normal-tab updates and closure', () => {
		const normal = { id: 'normal', title: 'Before', url: 'https://example.test/' };
		const privateTab = {
			id: 'private',
			title: 'Private',
			url: 'https://private.test/',
			ephemeral: true,
		};
		const baseline = { browserTabs: [normal], activeBrowserTabId: 'normal' };
		const local = { browserTabs: [normal, privateTab], activeBrowserTabId: 'private' };
		const updated = mergeSessionPersistenceChanges(
			{ ...baseline, browserTabs: [{ ...normal, title: 'After' }] },
			local,
			baseline,
			true,
			true
		);
		expect(updated.browserTabs).toEqual([{ ...normal, title: 'After' }, privateTab]);
		expect(updated.activeBrowserTabId).toBe('private');
		const closedNormal = mergeSessionPersistenceChanges(
			{ ...baseline, browserTabs: [] },
			local,
			baseline,
			true,
			true
		);
		expect(closedNormal.browserTabs).toEqual([privateTab]);
		expect(closedNormal.activeBrowserTabId).toBe('private');
	});
});
