import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	isLibraryRuntimeHosting,
	loadLibraryRuntimeStatus,
	resetLibraryRuntimeStatus,
} from '../../../renderer/services/libraryRuntime';

type MaybeApi = { libraryRuntime?: { status: () => Promise<unknown>; onEvent: () => void } };

describe('libraryRuntime service', () => {
	beforeEach(() => {
		resetLibraryRuntimeStatus();
	});
	afterEach(() => {
		resetLibraryRuntimeStatus();
		delete (window.maestro as unknown as MaybeApi).libraryRuntime;
	});

	it('is OFF before main has answered', () => {
		expect(isLibraryRuntimeHosting()).toBe(false);
	});

	it('is OFF when the preload namespace is missing, which keeps every existing test as it was', async () => {
		delete (window.maestro as unknown as MaybeApi).libraryRuntime;
		const status = await loadLibraryRuntimeStatus();
		expect(status.hosting).toBe(false);
		expect(isLibraryRuntimeHosting()).toBe(false);
	});

	it('is ON once main says it hosts the runtime', async () => {
		(window.maestro as unknown as MaybeApi).libraryRuntime = {
			status: vi.fn().mockResolvedValue({ hosting: true }),
			onEvent: vi.fn(),
		};
		expect(await loadLibraryRuntimeStatus()).toEqual({ hosting: true });
		expect(isLibraryRuntimeHosting()).toBe(true);
	});

	it('asks main once: the mode is fixed for the run (DM2)', async () => {
		const status = vi.fn().mockResolvedValue({ hosting: true });
		(window.maestro as unknown as MaybeApi).libraryRuntime = { status, onEvent: vi.fn() };

		await Promise.all([loadLibraryRuntimeStatus(), loadLibraryRuntimeStatus()]);
		await loadLibraryRuntimeStatus();

		expect(status).toHaveBeenCalledTimes(1);
	});

	it('reads a failed call as OFF instead of rejecting', async () => {
		(window.maestro as unknown as MaybeApi).libraryRuntime = {
			status: vi.fn().mockRejectedValue(new Error('ipc closed')),
			onEvent: vi.fn(),
		};
		await expect(loadLibraryRuntimeStatus()).resolves.toMatchObject({ hosting: false });
		expect(isLibraryRuntimeHosting()).toBe(false);
	});
});
