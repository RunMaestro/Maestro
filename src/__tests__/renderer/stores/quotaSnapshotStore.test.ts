import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { createQuotaSnapshotStore } from '../../../renderer/stores/quotaSnapshotStore';

/**
 * The store owns the main-side re-sample so it outlives the panel that
 * started it. The behaviours pinned here are the ones the user sees: a sample
 * that keeps running and fills the map in with nothing mounted, one sample per
 * burst of clicks, and a fresh pull never dropped behind an older one.
 */

interface Snap {
	value: number;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let fetchSnapshots: Mock<() => Promise<Record<string, Snap> | null | undefined>>;
let sampleOnMain: Mock<() => Promise<unknown>>;
let useStore: ReturnType<typeof createQuotaSnapshotStore<Snap>>;

beforeEach(() => {
	fetchSnapshots = vi
		.fn<() => Promise<Record<string, Snap> | null | undefined>>()
		.mockResolvedValue({ a: { value: 1 } });
	sampleOnMain = vi.fn<() => Promise<unknown>>().mockResolvedValue({ refreshed: 1 });
	useStore = createQuotaSnapshotStore<Snap>({ fetchSnapshots, sampleOnMain });
});

describe('createQuotaSnapshotStore - sample()', () => {
	it('samples on main, then pulls the fresh map into the store', async () => {
		await useStore.getState().sample();

		expect(sampleOnMain).toHaveBeenCalledTimes(1);
		expect(fetchSnapshots).toHaveBeenCalledTimes(1);
		expect(useStore.getState().snapshots).toEqual({ a: { value: 1 } });
		expect(useStore.getState().sampling).toBe(false);
	});

	it('reports sampling while main is still working, with no subscriber attached', async () => {
		const main = deferred<unknown>();
		sampleOnMain.mockReturnValue(main.promise);

		const run = useStore.getState().sample();
		expect(useStore.getState().sampling).toBe(true);

		main.resolve({ refreshed: 1 });
		await run;
		expect(useStore.getState().sampling).toBe(false);
		expect(useStore.getState().snapshots).toEqual({ a: { value: 1 } });
	});

	it('joins an in-flight sample instead of starting a second one', async () => {
		const main = deferred<unknown>();
		sampleOnMain.mockReturnValue(main.promise);

		const first = useStore.getState().sample();
		const second = useStore.getState().sample();
		expect(second).toBe(first);

		main.resolve({ refreshed: 1 });
		await first;
		expect(sampleOnMain).toHaveBeenCalledTimes(1);
	});

	it('still pulls the cached map when the main-side sample fails', async () => {
		sampleOnMain.mockRejectedValue(new Error('spawn failed'));

		await useStore.getState().sample();

		expect(fetchSnapshots).toHaveBeenCalledTimes(1);
		expect(useStore.getState().snapshots).toEqual({ a: { value: 1 } });
		expect(useStore.getState().sampling).toBe(false);
	});

	it('can sample again once the previous run has settled', async () => {
		await useStore.getState().sample();
		await useStore.getState().sample();

		expect(sampleOnMain).toHaveBeenCalledTimes(2);
	});
});

describe('createQuotaSnapshotStore - refresh()', () => {
	it('runs one trailing pull when called during an in-flight pull', async () => {
		const firstPull = deferred<Record<string, Snap> | null | undefined>();
		fetchSnapshots
			.mockReturnValueOnce(firstPull.promise)
			.mockResolvedValueOnce({ a: { value: 2 } });

		const first = useStore.getState().refresh();
		const second = useStore.getState().refresh();
		const third = useStore.getState().refresh();
		expect(second).toBe(first);
		expect(third).toBe(first);

		firstPull.resolve({ a: { value: 1 } });
		await first;

		// Older pull first, then exactly one trailing pull with the newer data.
		expect(fetchSnapshots).toHaveBeenCalledTimes(2);
		expect(useStore.getState().snapshots).toEqual({ a: { value: 2 } });
		expect(useStore.getState().refreshing).toBe(false);
	});

	it('keeps the last good map when a pull fails', async () => {
		await useStore.getState().refresh();
		fetchSnapshots.mockRejectedValueOnce(new Error('ipc down'));

		await useStore.getState().refresh();

		expect(useStore.getState().snapshots).toEqual({ a: { value: 1 } });
		expect(useStore.getState().loaded).toBe(true);
	});

	it('does not wedge when the fetch throws synchronously', async () => {
		fetchSnapshots.mockImplementationOnce(() => {
			throw new TypeError('bridge missing');
		});

		await useStore.getState().refresh();
		expect(useStore.getState().refreshing).toBe(false);

		await useStore.getState().refresh();
		expect(fetchSnapshots).toHaveBeenCalledTimes(2);
	});
});

describe('createQuotaSnapshotStore - __resetForTests()', () => {
	it('orphans a run started before the reset', async () => {
		const main = deferred<unknown>();
		sampleOnMain.mockReturnValueOnce(main.promise);

		const stale = useStore.getState().sample();
		useStore.getState().__resetForTests();
		expect(useStore.getState().sampling).toBe(false);

		// A new sample starts its own run rather than joining the orphaned one.
		const fresh = useStore.getState().sample();
		expect(fresh).not.toBe(stale);
		await fresh;

		main.resolve({ refreshed: 1 });
		await stale;
		expect(useStore.getState().sampling).toBe(false);
		expect(sampleOnMain).toHaveBeenCalledTimes(2);
	});
});
