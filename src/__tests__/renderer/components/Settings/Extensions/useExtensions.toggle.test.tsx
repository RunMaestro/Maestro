/**
 * useExtensions.toggleBuiltin is now the PRE-ENABLE PERMISSION GATE.
 *
 * Enabling a first-party Encore feature that declares real capabilities no
 * longer mints synchronously: it stages a `pendingEnable` (the modal's data)
 * and mints NOTHING until the user confirms. The gate is the whole point, so
 * these tests assert the NEGATIVE first - `setFirstPartyEnabled` is not called
 * on toggle - and only the confirm path routes through the host-owned
 * lifecycle bridge (plugins:first-party-set-enabled). The renderer store syncs
 * from the bridge's SETTLED state (which may be OFF when the grant mint failed
 * closed); only a bridge REJECTION falls back to a direct settings write, and
 * loudly. Cancel mints nothing. Disable (and non-first-party enable) still
 * commit immediately - there is nothing to review when removing access.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';
import { FIRST_PARTY_PLUGINS } from '../../../../../shared/plugins/first-party';
import type { PluginRecord } from '../../../../../shared/plugins/plugin-registry';
import { notifyToast } from '../../../../../renderer/stores/notificationStore';

const setEncoreFeatures = vi.fn();
const setStatsCollectionEnabled = vi.fn();

// Mutable so a test can flip a flag on to exercise the disable path. Reset to
// DEFAULT_FEATURES in beforeEach for full isolation. The store mock reads this
// object by reference, so in-place mutation is what the hook sees.
const DEFAULT_FEATURES: EncoreFeatureFlags = {
	directorNotes: false,
	usageStats: false,
	symphony: false,
	maestroCue: false,
	pianola: false,
	plugins: true,
};
const encoreFeatures: EncoreFeatureFlags = { ...DEFAULT_FEATURES };

vi.mock('../../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
		selector({ encoreFeatures, setEncoreFeatures, setStatsCollectionEnabled }),
}));

vi.mock('../../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

import { useExtensions } from '../../../../../renderer/components/Settings/Extensions/useExtensions';

const FIRST_PARTY_FLAGS = [
	'directorNotes',
	'usageStats',
	'symphony',
	'maestroCue',
	'pianola',
] as const;

const setFirstPartyEnabled = vi.fn();

// The mount `reload()` effect resolves its mocked IPC (list → contributions)
// across several microtask ticks and calls setState AFTER a synchronous test
// body returns - a late update that both warns and can bleed into the next
// test. Sync-shaped tests await this to settle the mount inside act().
async function flushMountEffects(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.assign(encoreFeatures, DEFAULT_FEATURES);
	setFirstPartyEnabled.mockResolvedValue({ enabled: true, authorized: true });
	(window as unknown as { maestro: unknown }).maestro = {
		plugins: {
			list: vi.fn().mockResolvedValue({ hostApiVersion: '1.0.0', plugins: [] }),
			contributions: vi.fn().mockResolvedValue({
				themes: [],
				iconPacks: [],
				prompts: [],
				settings: [],
				commandMacros: [],
				cueTriggers: [],
				commands: [],
				panels: [],
				agents: [],
				errorsByPlugin: {},
			}),
			onChanged: vi.fn(() => () => {}),
			setFirstPartyEnabled,
		},
		fs: { readFile: vi.fn() },
	};
});

afterEach(() => {
	(window as unknown as { maestro: unknown }).maestro = undefined;
});

describe('useExtensions.toggleBuiltin - the pre-enable permission gate', () => {
	it.each(FIRST_PARTY_FLAGS)(
		'"%s": enable stages pendingEnable and mints NOTHING until confirm',
		async (flag) => {
			const def = FIRST_PARTY_PLUGINS[flag];
			const { result } = renderHook(() => useExtensions());

			act(() => {
				result.current.toggleBuiltin(flag);
			});

			// The gate: staged for review, nothing committed to the bridge or store.
			expect(result.current.pendingEnable).toEqual({
				flag,
				name: def.name,
				permissions: def.permissions,
			});
			expect(setFirstPartyEnabled).not.toHaveBeenCalled();
			expect(setEncoreFeatures).not.toHaveBeenCalled();

			// Confirm commits through the bridge and syncs the store from the
			// settled (enabled) state, then clears the stage.
			act(() => {
				result.current.confirmPendingEnable();
			});

			expect(setFirstPartyEnabled).toHaveBeenCalledWith(flag, true);
			await waitFor(() => {
				expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, [flag]: true });
			});
			await waitFor(() => {
				expect(result.current.pendingEnable).toBeNull();
			});
		}
	);

	it.each(FIRST_PARTY_FLAGS)(
		'"%s": cancelPendingEnable mints nothing and clears the stage',
		async (flag) => {
			const { result } = renderHook(() => useExtensions());

			act(() => {
				result.current.toggleBuiltin(flag);
			});
			expect(result.current.pendingEnable).not.toBeNull();

			act(() => {
				result.current.cancelPendingEnable();
			});

			expect(result.current.pendingEnable).toBeNull();
			expect(setFirstPartyEnabled).not.toHaveBeenCalled();
			expect(setEncoreFeatures).not.toHaveBeenCalled();
			expect(setStatsCollectionEnabled).not.toHaveBeenCalled();
			await flushMountEffects();
		}
	);
});

describe('confirmPendingEnable - bridge routing & failure semantics', () => {
	it('syncs the store from the bridge state even when the mint fails closed', async () => {
		// Grant mint under-delivered: the bridge settles OFF despite enable=true.
		setFirstPartyEnabled.mockResolvedValue({ enabled: false, authorized: false });
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('pianola');
		});
		act(() => {
			result.current.confirmPendingEnable();
		});

		expect(setFirstPartyEnabled).toHaveBeenCalledWith('pianola', true);
		// Store follows the settled OFF state, NOT the optimistic true.
		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, pianola: false });
		});
	});

	it('keeps the main-process stats recording gate in lockstep with usageStats', async () => {
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('usageStats');
		});
		act(() => {
			result.current.confirmPendingEnable();
		});

		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, usageStats: true });
		});
		expect(setStatsCollectionEnabled).toHaveBeenCalledWith(true);
	});

	it('does not touch the stats gate for other first-party flags', async () => {
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('symphony');
		});
		act(() => {
			result.current.confirmPendingEnable();
		});

		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, symphony: true });
		});
		expect(setStatsCollectionEnabled).not.toHaveBeenCalled();
	});

	it('falls back to the direct settings write (loudly) when the bridge call rejects', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		setFirstPartyEnabled.mockRejectedValue(new Error('FirstPartyBridgeUnavailable'));
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('maestroCue');
		});
		act(() => {
			result.current.confirmPendingEnable();
		});

		// Fallback writes the optimistic value so the toggle still works.
		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, maestroCue: true });
		});
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('maestroCue'),
			expect.any(Error)
		);
		consoleError.mockRestore();
	});
});

describe('useExtensions.toggleBuiltin - immediate commits (no modal)', () => {
	it('non-first-party flags (plugins subsystem) disable directly, no bridge, no modal', async () => {
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('plugins');
		});

		expect(result.current.pendingEnable).toBeNull();
		expect(setFirstPartyEnabled).not.toHaveBeenCalled();
		expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, plugins: false });
		await flushMountEffects();
	});

	it('an already-enabled first-party flag disables through the bridge with no modal', async () => {
		// Pianola is ON: toggling it is a DISABLE - nothing to review, so it
		// commits immediately through the bridge and never stages a modal.
		encoreFeatures.pianola = true;
		setFirstPartyEnabled.mockResolvedValue({ enabled: false, authorized: false });
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('pianola');
		});

		expect(result.current.pendingEnable).toBeNull();
		expect(setFirstPartyEnabled).toHaveBeenCalledWith('pianola', false);
		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, pianola: false });
		});
	});
});

describe('useExtensions.updatePlugin', () => {
	const record = {
		id: 'demo-plugin',
		manifest: { id: 'demo-plugin', name: 'Demo Plugin', version: '1.0.0' },
	} as PluginRecord;

	it('updates through the host, refreshes the list, and reports the new version', async () => {
		const list = vi.mocked(window.maestro.plugins.list);
		const update = vi.fn().mockResolvedValue({
			hostApiVersion: '1.0.0',
			plugins: [{ ...record, manifest: { ...record.manifest, version: '2.0.0' } }],
		});
		window.maestro.plugins.update = update;
		window.maestro.dialog = {
			selectFolder: vi.fn().mockResolvedValue('/local/demo-v2'),
		} as unknown as typeof window.maestro.dialog;
		window.maestro.fs.readFile = vi.fn().mockResolvedValue(JSON.stringify({ id: record.id }));
		const { result } = renderHook(() => useExtensions());
		await flushMountEffects();

		await act(async () => result.current.updatePlugin(record));

		expect(update).toHaveBeenCalledExactlyOnceWith('/local/demo-v2');
		expect(list).toHaveBeenCalledTimes(2);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'green', message: 'Updated Demo Plugin to v2.0.0' })
		);
		expect(result.current.busyId).toBeNull();
	});

	it('explains how to renew consent when an update leaves the plugin disabled', async () => {
		window.maestro.plugins.update = vi.fn().mockResolvedValue({
			hostApiVersion: '1.0.0',
			plugins: [{ ...record, enabled: false, manifest: { ...record.manifest, version: '2.0.0' } }],
		});
		window.maestro.dialog = {
			selectFolder: vi.fn().mockResolvedValue('/local/demo-v2'),
		} as unknown as typeof window.maestro.dialog;
		window.maestro.fs.readFile = vi.fn().mockResolvedValue(JSON.stringify({ id: record.id }));
		const { result } = renderHook(() => useExtensions());
		await flushMountEffects();

		await act(async () => result.current.updatePlugin(record));

		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'orange',
				message:
					'Updated Demo Plugin to v2.0.0. Plugin is disabled. Select Enable to review permissions for this version.',
			})
		);
	});

	it('does nothing after folder selection is cancelled', async () => {
		const update = vi.fn();
		window.maestro.plugins.update = update;
		window.maestro.dialog = {
			selectFolder: vi.fn().mockResolvedValue(null),
		} as unknown as typeof window.maestro.dialog;
		window.maestro.fs.readFile = vi.fn();
		const { result } = renderHook(() => useExtensions());
		await flushMountEffects();

		await act(async () => result.current.updatePlugin(record));

		expect(update).not.toHaveBeenCalled();
		expect(window.maestro.fs.readFile).not.toHaveBeenCalled();
		expect(notifyToast).not.toHaveBeenCalled();
		expect(result.current.busyId).toBeNull();
	});

	it('shows the host rejection and leaves the installed list untouched', async () => {
		const list = vi.mocked(window.maestro.plugins.list);
		window.maestro.plugins.update = vi
			.fn()
			.mockRejectedValue(new Error('update version is not newer'));
		window.maestro.dialog = {
			selectFolder: vi.fn().mockResolvedValue('/local/demo-old'),
		} as unknown as typeof window.maestro.dialog;
		window.maestro.fs.readFile = vi.fn().mockResolvedValue(JSON.stringify({ id: record.id }));
		const { result } = renderHook(() => useExtensions());
		await flushMountEffects();

		await act(async () => result.current.updatePlugin(record));

		expect(list).toHaveBeenCalledTimes(1);
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: expect.stringContaining('not newer') })
		);
		expect(result.current.busyId).toBeNull();
	});

	it('rejects a folder for a different installed plugin before invoking update', async () => {
		const update = vi.fn();
		window.maestro.plugins.update = update;
		window.maestro.dialog = {
			selectFolder: vi.fn().mockResolvedValue('/local/other-plugin'),
		} as unknown as typeof window.maestro.dialog;
		window.maestro.fs.readFile = vi.fn().mockResolvedValue(JSON.stringify({ id: 'other-plugin' }));
		const { result } = renderHook(() => useExtensions());
		await flushMountEffects();

		await act(async () => result.current.updatePlugin(record));

		expect(update).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				message: expect.stringContaining('not for demo-plugin'),
			})
		);
	});

	it.each([
		{
			name: 'unreadable',
			readFile: () => Promise.reject(new Error('IPC failure')),
			message: 'Could not read plugin.json',
		},
		{
			name: 'invalid JSON',
			readFile: () => Promise.resolve('{invalid'),
			message: 'invalid plugin.json',
		},
	])('explains an $name plugin.json before invoking update', async ({ readFile, message }) => {
		const update = vi.fn();
		window.maestro.plugins.update = update;
		window.maestro.dialog = {
			selectFolder: vi.fn().mockResolvedValue('/local/bad-plugin'),
		} as unknown as typeof window.maestro.dialog;
		window.maestro.fs.readFile = vi.fn(readFile);
		const { result } = renderHook(() => useExtensions());
		await flushMountEffects();

		await act(async () => result.current.updatePlugin(record));

		expect(update).not.toHaveBeenCalled();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ color: 'red', message: expect.stringContaining(message) })
		);
	});
});
