/**
 * @file acappella-runtimes.test.ts
 *
 * The native-runtime IPC channels: `runtimes:list`, `runtimes:install`,
 * `runtimes:footprint`, and `runtimes:remove-all`.
 *
 * These exist because a downloaded MODEL is inert without an engine to read it.
 * The local tier used to be unreachable for exactly that reason - the model
 * catalog could be fetched, the runtime could not, and voice refused with a
 * message about a runtime nobody had any way to install.
 *
 * Four properties are worth protecting, and each was a deliberate decision:
 *
 *   - **Listing touches no network.** Mounting Voice Setup must never open a
 *     socket; the artifact table already knows every size and hash.
 *   - **A second install joins the first.** `installNativeRuntime` clears its
 *     staging directory on entry, so two concurrent installs of one runtime would
 *     delete each other's partial download and race to rename onto one target.
 *   - **A finished install forgets the loader's cached failure.** The loader
 *     remembers a failed dlopen so it does not retry per utterance; without the
 *     reset, a user downloads the engine and voice keeps refusing until restart.
 *   - **Reclaiming disk survives the feature being switched off.** A runtime is
 *     the larger half of what someone frees when they stop wanting voice.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../../main/acappella/runtime/runtime-installer', () => ({
	installNativeRuntime: vi.fn(),
}));

vi.mock('../../../../main/acappella/runtime/runtime-store', () => ({
	artifactForThisPlatform: vi.fn(),
	isRuntimeInstalled: vi.fn(async () => false),
	isRuntimeStale: vi.fn(async () => false),
	removeAllRuntimes: vi.fn(async () => {}),
	runtimesFootprint: vi.fn(async () => 0),
}));

vi.mock('../../../../main/acappella/runtime/native-loader', () => ({
	resetNativeRuntimes: vi.fn(),
}));

// The model half of this handler module reaches for a downloader singleton and
// the capability gate; neither is what these tests are about.
vi.mock('../../../../main/acappella/models/model-downloader', () => ({
	getModelDownloader: () => ({ onProgress: vi.fn(), download: vi.fn() }),
}));

import {
	registerACappellaModelsHandlers,
	ACAPPELLA_RUNTIME_PROGRESS_CHANNEL,
	type VoiceRuntimeListing,
} from '../../../../main/ipc/handlers/acappella-models';
import { installNativeRuntime } from '../../../../main/acappella/runtime/runtime-installer';
import {
	artifactForThisPlatform,
	isRuntimeInstalled,
	isRuntimeStale,
	removeAllRuntimes,
	runtimesFootprint,
} from '../../../../main/acappella/runtime/runtime-store';
import { resetNativeRuntimes } from '../../../../main/acappella/runtime/native-loader';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

let settings: Record<string, unknown>;
const broadcasts: Array<{ channel: string; payload: unknown }> = [];

const settingsStore = {
	get: (key: string, fallback?: unknown) => settings[key] ?? fallback,
};

const safeSend = vi.fn((channel: string, payload: unknown) => {
	broadcasts.push({ channel, payload });
});

function handlerFor(channel: string): Handler {
	const registration = vi
		.mocked(ipcMain.handle)
		.mock.calls.find(([registered]) => registered === channel);
	expect(registration, `no handler registered for ${channel}`).toBeDefined();
	return registration?.[1] as unknown as Handler;
}

/** A resolvable promise, for driving concurrency deterministically. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

beforeEach(() => {
	vi.clearAllMocks();
	settings = { encoreFeatures: { aCappella: true } };
	broadcasts.length = 0;
	vi.mocked(isRuntimeInstalled).mockResolvedValue(false);
	vi.mocked(isRuntimeStale).mockResolvedValue(false);
	vi.mocked(runtimesFootprint).mockResolvedValue(0);
	vi.mocked(artifactForThisPlatform).mockReturnValue({ bytes: 100_893_124 } as never);
	registerACappellaModelsHandlers({ settingsStore, safeSend: safeSend as never });
});

describe('A Cappella runtime IPC handlers', () => {
	describe('listing', () => {
		it('joins every registered runtime to its on-disk state without touching the network', async () => {
			const listings = (await handlerFor('runtimes:list')({})) as VoiceRuntimeListing[];

			expect(listings.length).toBeGreaterThan(0);
			for (const listing of listings) {
				expect(listing.id).toBeTruthy();
				expect(listing.label).toBeTruthy();
				expect(listing.slots.length).toBeGreaterThan(0);
				expect(listing.installed).toBe(false);
				expect(listing.downloadable).toBe(true);
				expect(listing.bytes).toBe(100_893_124);
			}
			// The proof it was a disk read: nothing was installed, and the sizes came
			// from the frozen artifact table rather than from a HEAD request.
			expect(installNativeRuntime).not.toHaveBeenCalled();
		});

		it('reports a platform with no published payload as not downloadable', async () => {
			// Distinct from "not installed yet": one is a button, the other is an
			// explanation, and offering a download that cannot exist is worse than
			// saying nothing.
			vi.mocked(artifactForThisPlatform).mockReturnValue(null);

			const listings = (await handlerFor('runtimes:list')({})) as VoiceRuntimeListing[];

			expect(listings.every((listing) => listing.downloadable === false)).toBe(true);
			expect(listings.every((listing) => listing.bytes === 0)).toBe(true);
		});

		it('reports an installed runtime whose payload no longer matches as stale', async () => {
			vi.mocked(isRuntimeInstalled).mockResolvedValue(true);
			vi.mocked(isRuntimeStale).mockResolvedValue(true);

			const listings = (await handlerFor('runtimes:list')({})) as VoiceRuntimeListing[];

			expect(listings.every((listing) => listing.installed && listing.stale)).toBe(true);
		});

		it('refuses when the Encore Feature is off', async () => {
			settings = {};
			await expect(handlerFor('runtimes:list')({})).rejects.toThrow('ACappellaDisabled');
		});
	});

	describe('install', () => {
		it('installs a runtime and broadcasts its progress', async () => {
			vi.mocked(installNativeRuntime).mockImplementation((async (_id, options) => {
				options?.onProgress?.({
					runtimeId: 'onnx',
					phase: 'downloading',
					bytes: 1024,
					totalBytes: 100_893_124,
				});
				return {} as never;
			}) as never);

			await expect(handlerFor('runtimes:install')({}, 'onnx')).resolves.toBe(true);

			expect(installNativeRuntime).toHaveBeenCalledWith('onnx', expect.anything());
			// Broadcast, not replied: every window watches the same transfer.
			expect(broadcasts).toContainEqual({
				channel: ACAPPELLA_RUNTIME_PROGRESS_CHANNEL,
				payload: expect.objectContaining({ runtimeId: 'onnx', phase: 'downloading' }),
			});
		});

		it('clears the loader’s remembered failure once the engine is on disk', async () => {
			// The loader caches a failed dlopen so it does not retry on every
			// utterance. That memory is stale in the good direction the moment the
			// runtime lands, and without this the user downloads the engine and voice
			// keeps refusing until the app restarts.
			vi.mocked(installNativeRuntime).mockResolvedValue({} as never);

			await handlerFor('runtimes:install')({}, 'onnx');

			expect(resetNativeRuntimes).toHaveBeenCalled();
		});

		it('joins an install already in flight rather than starting a second', async () => {
			// `installNativeRuntime` clears its staging directory on entry, so two
			// concurrent installs of one runtime delete each other's partial download
			// and race to rename onto the same target.
			const gate = deferred<never>();
			vi.mocked(installNativeRuntime).mockReturnValue(gate.promise);

			const first = handlerFor('runtimes:install')({}, 'onnx');
			const second = handlerFor('runtimes:install')({}, 'onnx');
			gate.resolve({} as never);

			await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
			expect(installNativeRuntime).toHaveBeenCalledTimes(1);
		});

		it('allows a fresh install after the previous one settled', async () => {
			// The in-flight map must be cleared on completion, or a failed install
			// could never be retried without restarting the app.
			vi.mocked(installNativeRuntime).mockResolvedValue({} as never);

			await handlerFor('runtimes:install')({}, 'onnx');
			await handlerFor('runtimes:install')({}, 'onnx');

			expect(installNativeRuntime).toHaveBeenCalledTimes(2);
		});

		it('releases the in-flight slot when an install fails', async () => {
			vi.mocked(installNativeRuntime).mockRejectedValueOnce(new Error('hash mismatch'));

			await expect(handlerFor('runtimes:install')({}, 'onnx')).rejects.toThrow('hash mismatch');

			// A retry must actually retry rather than replaying the rejection.
			vi.mocked(installNativeRuntime).mockResolvedValue({} as never);
			await expect(handlerFor('runtimes:install')({}, 'onnx')).resolves.toBe(true);
		});

		it('rejects an id that is not a known runtime before it can reach a path join', async () => {
			await expect(handlerFor('runtimes:install')({}, '../../etc/passwd')).rejects.toThrow(
				'UnknownVoiceRuntime'
			);
			await expect(handlerFor('runtimes:install')({}, 42)).rejects.toThrow('UnknownVoiceRuntime');
			expect(installNativeRuntime).not.toHaveBeenCalled();
		});

		it('refuses when the Encore Feature is off', async () => {
			settings = {};
			await expect(handlerFor('runtimes:install')({}, 'onnx')).rejects.toThrow('ACappellaDisabled');
			expect(installNativeRuntime).not.toHaveBeenCalled();
		});
	});

	describe('reclaiming disk', () => {
		it('reports and frees runtime disk even with the Encore Feature off', async () => {
			// Ungated on purpose, alongside the model equivalents: the reclaim-disk
			// offer exists precisely for the moment after voice was switched off, and
			// a feature that hides the button freeing hundreds of megabytes the moment
			// you stop wanting it is holding the disk hostage.
			settings = {};
			vi.mocked(runtimesFootprint).mockResolvedValue(37_000_000);

			await expect(handlerFor('runtimes:footprint')({})).resolves.toBe(37_000_000);
			await expect(handlerFor('runtimes:remove-all')({})).resolves.toBeUndefined();
			expect(removeAllRuntimes).toHaveBeenCalled();
		});

		it('drops whatever is dlopened when the files are deleted', async () => {
			// Otherwise the loader keeps handing out a module backed by files that no
			// longer exist.
			await handlerFor('runtimes:remove-all')({});
			expect(resetNativeRuntimes).toHaveBeenCalled();
		});
	});
});
