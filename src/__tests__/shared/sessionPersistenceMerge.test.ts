import { describe, expect, it } from 'vitest';
import { mergeSessionPersistenceChanges } from '../../shared/sessionPersistenceMerge';

describe('observed session changes', () => {
	it('preserves only unchanged Host-observed human queue origins on remote saves', () => {
		const item = { id: 'human', type: 'message', text: 'Read mail', querySource: 'user' };
		const stored = { executionQueue: [item] };
		expect(
			mergeSessionPersistenceChanges(stored, stored, stored, true, false, true).executionQueue[0]
		).toEqual(item);
		for (const changed of [
			{ ...item, text: 'Different operation' },
			{ ...item, tabId: 'other-tab' },
			{ ...item, id: 'new-item' },
		]) {
			const incoming = { executionQueue: [changed] };
			const merged = mergeSessionPersistenceChanges(incoming, stored, stored, true, false, true);
			expect(merged.executionQueue[0].querySource).toBe('auto');
		}
		const incoming = { executionQueue: [item] };
		expect(
			mergeSessionPersistenceChanges(incoming, undefined, undefined, true, false, true)
				.executionQueue[0].querySource
		).toBe('auto');
		expect(
			mergeSessionPersistenceChanges(incoming, undefined, undefined).executionQueue[0].querySource
		).toBe('user');
		expect(
			mergeSessionPersistenceChanges(incoming, undefined, undefined, true).executionQueue[0]
				.querySource
		).toBe('user');
	});

	it('does not accept a remote user claim for existing automatic or legacy queue items', () => {
		for (const querySource of ['auto', undefined]) {
			const stored = { executionQueue: [{ id: 'item', text: 'Read mail', querySource }] };
			const incoming = { executionQueue: [{ ...stored.executionQueue[0], querySource: 'user' }] };
			expect(
				mergeSessionPersistenceChanges(incoming, stored, stored, true, false, true)
					.executionQueue[0].querySource
			).toBe('auto');
		}
	});

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

	it('does not rebase a stale drag across a newly installed admission hold', () => {
		const before = { id: 'a', tabId: 'tab-1', type: 'message' };
		const held = { id: 'held', tabId: 'tab-1', type: 'message' };
		const after = { id: 'b', tabId: 'tab-1', type: 'message' };
		const baseline = { executionQueue: [before, held, after] };
		const stored = { executionQueue: [before, { ...held, pendingAdmissionId: 'dispatch' }, after] };
		const incoming = { executionQueue: [after, before, held] };
		expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
			stored.executionQueue
		);
	});

	it('retains an existing admission hold across observed and baseline-less renderer saves', () => {
		const item = { id: 'held', type: 'message', tabId: 'tab', pendingAdmissionId: 'dispatch' };
		const stored = { executionQueue: [item] };
		for (const replacement of [undefined, 'different-dispatch']) {
			const incoming = { executionQueue: [{ ...item, pendingAdmissionId: replacement }] };
			for (const baseline of [stored, undefined]) {
				expect(
					mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue[0]
						.pendingAdmissionId
				).toBe('dispatch');
			}
		}
		const renamedType: {
			executionQueue: { id: string; type: string; tabId: string; pendingAdmissionId?: string }[];
		} = {
			executionQueue: [{ ...item, type: 'other', pendingAdmissionId: undefined }],
		};
		expect(
			mergeSessionPersistenceChanges(renamedType, stored, undefined).executionQueue[0]
				.pendingAdmissionId
		).toBe('dispatch');
	});

	it('still permits cancellation of a held item without transferring its hold to another row', () => {
		const held = { id: 'held', type: 'message', pendingAdmissionId: 'dispatch' };
		const other = { id: 'other', type: 'message' };
		const stored = { executionQueue: [held, other] };
		const incoming = { executionQueue: [other] };
		expect(mergeSessionPersistenceChanges(incoming, stored, stored).executionQueue).toEqual([
			other,
		]);
	});

	it('keeps the exact held operation across changed payload, tab and type while allowing pause', () => {
		const held = {
			id: 'held',
			type: 'message',
			tabId: 'tab',
			text: 'original',
			images: ['original-image'],
			pendingAdmissionId: 'dispatch',
		};
		const stored = { executionQueue: [held] };
		const incoming = {
			executionQueue: [
				{
					...held,
					type: 'command',
					tabId: 'other',
					text: 'changed',
					images: ['changed-image'],
					pendingAdmissionId: 'other-dispatch',
					paused: true,
				},
			],
		};
		for (const baseline of [stored, undefined]) {
			expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual([
				{ ...held, paused: true },
			]);
		}
	});

	it('does not allow a changed tab or removed hold to bypass the queue order barrier', () => {
		const before = { id: 'before', type: 'message', tabId: 'tab' };
		const held = { id: 'held', type: 'message', tabId: 'tab', pendingAdmissionId: 'dispatch' };
		const after = { id: 'after', type: 'message', tabId: 'tab' };
		const stored = { executionQueue: [before, held, after] };
		const incoming = {
			executionQueue: [after, before, { ...held, tabId: 'other', pendingAdmissionId: '' }],
		};
		expect(mergeSessionPersistenceChanges(incoming, stored, stored).executionQueue).toEqual(
			stored.executionQueue
		);
	});

	it('does not move same-tab work across a peer-only admission hold during a stale drag', () => {
		const before = { id: 'a', tabId: 'tab-1', type: 'message' };
		const after = { id: 'b', tabId: 'tab-1', type: 'message' };
		const held = { id: 'held', tabId: 'tab-1', type: 'message', pendingAdmissionId: 'dispatch' };
		const baseline = { executionQueue: [before, after] };
		const stored = { executionQueue: [before, held, after] };
		const incoming = { executionQueue: [after, before] };
		expect(mergeSessionPersistenceChanges(incoming, stored, baseline).executionQueue).toEqual(
			stored.executionQueue
		);
	});

	it('keeps independent tab reordering when rebasing around an admission hold', () => {
		const held = { id: 'held', tabId: 'tab-1', type: 'message', pendingAdmissionId: 'dispatch' };
		const other = { id: 'other', tabId: 'tab-2', type: 'message' };
		const baseline = { executionQueue: [held, other] };
		const incoming = { executionQueue: [other, held] };
		expect(mergeSessionPersistenceChanges(incoming, baseline, baseline).executionQueue).toEqual(
			incoming.executionQueue
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

describe('consumed execution queue entries', () => {
	it.each([{ waitingForConnection: undefined }, { paused: true }, { text: 'edited' }])(
		'does not retain a consumed ID after a local metadata edit %j',
		(edit) => {
			const item = {
				id: 'consumed',
				type: 'message',
				text: 'Ja bitte',
				waitingForConnection: true,
			};
			const baseline = { executionQueue: [item] };
			const unsent = { id: 'unsent', type: 'message', text: 'new work' };
			const client = { executionQueue: [{ ...item, ...edit }, unsent] };
			expect(
				mergeSessionPersistenceChanges({ executionQueue: [] }, client, baseline, true, true)
					.executionQueue
			).toEqual([unsent]);
		}
	);

	it('persists a host dequeue even if a browser updated the stored queued item', () => {
		const item = { id: 'consumed', text: 'Ja bitte' };
		const baseline = { executionQueue: [item] };
		const stored = { executionQueue: [{ ...item, paused: true }] };
		expect(
			mergeSessionPersistenceChanges({ executionQueue: [] }, stored, baseline).executionQueue
		).toEqual([]);
	});

	it('still retains edited rows in other collections', () => {
		const baseline = { aiTabs: [{ id: 'edited', name: 'before' }] };
		const stored = { aiTabs: [{ id: 'edited', name: 'after' }] };
		expect(mergeSessionPersistenceChanges({ aiTabs: [] }, stored, baseline).aiTabs).toEqual(
			stored.aiTabs
		);
	});
});

describe('queue recovery generations', () => {
	it('does not resurrect an already consumed recovery from an older peer baseline', () => {
		const item = { id: 'recovered', dispatchRecoveryGeneration: 1 };
		expect(
			mergeSessionPersistenceChanges(
				{ executionQueue: [item] },
				{ executionQueue: [] },
				{ executionQueue: [{ id: item.id }] },
				true,
				true
			).executionQueue
		).toEqual([]);
	});

	it('does not restore an older recovered attempt after its removal', () => {
		const item = { id: 'recovered', dispatchRecoveryGeneration: 1 };
		expect(
			mergeSessionPersistenceChanges(
				{ executionQueue: [{ ...item, dispatchRecoveryGeneration: 0 }] },
				{ executionQueue: [] },
				{ executionQueue: [item] },
				true,
				true
			).executionQueue
		).toEqual([]);
	});
});
