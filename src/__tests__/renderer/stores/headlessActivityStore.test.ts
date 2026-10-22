import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	subscribeHeadlessActivity,
	useHeadlessActivityStore,
} from '../../../renderer/stores/headlessActivityStore';
import type { HeadlessAgentActivity } from '../../../shared/headlessAgentActivity';

beforeEach(() => useHeadlessActivityStore.setState({ revision: -1, counts: {} }));

describe('host headless activity mirror', () => {
	it('restores running counts after reload and rejects late snapshots and duplicate terminal events', async () => {
		let receive!: (value: HeadlessAgentActivity) => void;
		let resolveSnapshot!: (value: HeadlessAgentActivity) => void;
		const unsubscribe = vi.fn();
		window.maestro.process.getHeadlessActivity = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSnapshot = resolve;
				})
		);
		window.maestro.process.onHeadlessActivity = vi.fn((listener) => {
			receive = listener;
			return unsubscribe;
		});
		const stop = subscribeHeadlessActivity();
		resolveSnapshot({ revision: 1, counts: { target: 2 } });
		await Promise.resolve();
		expect(useHeadlessActivityStore.getState().counts).toEqual({ target: 2 });
		receive({ revision: 2, counts: { target: 1 } });
		receive({ revision: 1, counts: { target: 2 } });
		expect(useHeadlessActivityStore.getState().counts).toEqual({ target: 1 });
		receive({ revision: 3, counts: {} });
		receive({ revision: 3, counts: {} });
		expect(useHeadlessActivityStore.getState().counts).toEqual({});
		stop();
		receive({ revision: 4, counts: { target: 1 } });
		expect(useHeadlessActivityStore.getState().counts).toEqual({});
		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it('does not let the initial snapshot undo an event delivered while loading', async () => {
		let resolveSnapshot!: (value: HeadlessAgentActivity) => void;
		window.maestro.process.getHeadlessActivity = vi.fn(
			() =>
				new Promise((resolve) => {
					resolveSnapshot = resolve;
				})
		);
		window.maestro.process.onHeadlessActivity = vi.fn((receive) => {
			receive({ revision: 7, counts: {} });
			return vi.fn();
		});
		const stop = subscribeHeadlessActivity();
		resolveSnapshot({ revision: 6, counts: { target: 1 } });
		await Promise.resolve();
		expect(useHeadlessActivityStore.getState().counts).toEqual({});
		stop();
	});
});
