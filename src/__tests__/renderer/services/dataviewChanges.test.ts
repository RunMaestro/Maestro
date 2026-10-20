/**
 * One `dataview:changed` listener per window, shared by every mounted block
 * (DV-7), and the rule that decides whether a change makes a result stale.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	isDataviewChangeFor,
	subscribeDataviewChanges,
} from '../../../renderer/services/dataviewChanges';
import type { DataviewChangeEvent } from '../../../shared/dataview';

function change(overrides: Partial<DataviewChangeEvent> = {}): DataviewChangeEvent {
	return { root: '/vault', sshRemoteId: null, revision: 2, changedPaths: [], ...overrides };
}

describe('subscribeDataviewChanges', () => {
	it('installs one IPC listener for many subscribers and removes it with the last', () => {
		const unsubscribeIpc = vi.fn();
		let emit: (event: DataviewChangeEvent) => void = () => {};
		vi.mocked(window.maestro.dataview.onChanged).mockImplementation((handler) => {
			emit = handler;
			return unsubscribeIpc;
		});
		const first = vi.fn();
		const second = vi.fn();

		const offFirst = subscribeDataviewChanges(first);
		const offSecond = subscribeDataviewChanges(second);
		expect(window.maestro.dataview.onChanged).toHaveBeenCalledTimes(1);

		const event = change();
		emit(event);
		expect(first).toHaveBeenCalledWith(event);
		expect(second).toHaveBeenCalledWith(event);

		offFirst();
		expect(unsubscribeIpc).not.toHaveBeenCalled();
		emit(event);
		expect(first).toHaveBeenCalledTimes(1);

		offSecond();
		expect(unsubscribeIpc).toHaveBeenCalledTimes(1);
	});
});

describe('isDataviewChangeFor', () => {
	const shown = { root: '/vault', sshRemoteId: null, revision: 1 };

	it('matches a newer revision of the same root on the same host', () => {
		expect(isDataviewChangeFor(change(), shown)).toBe(true);
	});

	it('ignores another root, another host, or a revision already read', () => {
		expect(isDataviewChangeFor(change({ root: '/other' }), shown)).toBe(false);
		expect(isDataviewChangeFor(change({ sshRemoteId: 'remote-1' }), shown)).toBe(false);
		expect(isDataviewChangeFor(change({ revision: 1 }), shown)).toBe(false);
	});
});
