/**
 * useExtensions.toggleBuiltin routing: every first-party Encore flag goes
 * through the host-owned lifecycle bridge (plugins:first-party-set-enabled),
 * NOT a bare settings write. The renderer store is synced from the bridge's
 * settled state (which may be OFF when the grant mint failed closed). Only
 * when the bridge call itself rejects does the hook fall back to the direct
 * settings write — loudly.
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EncoreFeatureFlags } from '../../../../../renderer/types';

const setEncoreFeatures = vi.fn();
const setStatsCollectionEnabled = vi.fn();
const encoreFeatures: EncoreFeatureFlags = {
	directorNotes: false,
	usageStats: false,
	symphony: false,
	maestroCue: false,
	pianola: false,
	plugins: true,
};

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

beforeEach(() => {
	vi.clearAllMocks();
	setFirstPartyEnabled.mockResolvedValue({ enabled: true, authorized: true });
	(window as unknown as { maestro: unknown }).maestro = {
		plugins: {
			list: vi.fn().mockResolvedValue({ hostApiVersion: '1.0.0', plugins: [] }),
			contributions: vi.fn().mockResolvedValue({
				themes: [],
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
	};
});

afterEach(() => {
	(window as unknown as { maestro: unknown }).maestro = undefined;
});

describe('useExtensions.toggleBuiltin routes first-party flags through the bridge', () => {
	it.each(FIRST_PARTY_FLAGS)(
		'"%s" enable goes through plugins:first-party-set-enabled',
		async (flag) => {
			const { result } = renderHook(() => useExtensions());

			act(() => {
				result.current.toggleBuiltin(flag);
			});

			expect(setFirstPartyEnabled).toHaveBeenCalledWith(flag, true);
			// The store syncs from the bridge's settled state, not the optimistic value.
			await waitFor(() => {
				expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, [flag]: true });
			});
		}
	);

	it('syncs the store from the bridge state even when the bridge fails closed', async () => {
		// Grant mint under-delivered: the bridge settles OFF despite enable=true.
		setFirstPartyEnabled.mockResolvedValue({ enabled: false, authorized: false });
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('pianola');
		});

		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, pianola: false });
		});
	});

	it('keeps the main-process stats recording gate in lockstep with usageStats', async () => {
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('usageStats');
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

		await waitFor(() => {
			expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, maestroCue: true });
		});
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('maestroCue'),
			expect.any(Error)
		);
		consoleError.mockRestore();
	});

	it('non-first-party flags (plugins subsystem) still write settings directly', () => {
		const { result } = renderHook(() => useExtensions());

		act(() => {
			result.current.toggleBuiltin('plugins');
		});

		expect(setFirstPartyEnabled).not.toHaveBeenCalled();
		expect(setEncoreFeatures).toHaveBeenCalledWith({ ...encoreFeatures, plugins: false });
	});
});
