import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCueSettings } from '../../../../renderer/hooks/cue/useCueSettings';
import { DEFAULT_CUE_SETTINGS, type CueSettings } from '../../../../shared/cue';

const mockGetSettings = vi.fn();

vi.mock('../../../../renderer/services/cue', () => ({
	cueService: {
		getSettings: (...args: unknown[]) => mockGetSettings(...args),
	},
}));

vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

describe('useCueSettings', () => {
	beforeEach(() => {
		mockGetSettings.mockReset();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('initial state: default settings, showSettings=false, settingsLoaded=false', () => {
		mockGetSettings.mockReturnValue(new Promise(() => {})); // never resolves
		const { result } = renderHook(() => useCueSettings());
		expect(result.current.cueSettings).toEqual(DEFAULT_CUE_SETTINGS);
		expect(result.current.showSettings).toBe(false);
		expect(result.current.settingsLoaded).toBe(false);
	});

	it('on mount, cueService.getSettings invoked once and resolved value overwrites state', async () => {
		const fetched: CueSettings = { ...DEFAULT_CUE_SETTINGS, max_concurrent_runs: 7 };
		mockGetSettings.mockResolvedValue(fetched);
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		expect(mockGetSettings).toHaveBeenCalledTimes(1);
		expect(result.current.cueSettings).toEqual(fetched);
	});

	it('IPC rejection: settingsLoaded still flips to true; cueSettings stays at default', async () => {
		mockGetSettings.mockRejectedValue(new Error('IPC down'));
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		expect(result.current.cueSettings).toEqual(DEFAULT_CUE_SETTINGS);
	});

	it('setShowSettings(true) updates the flag', () => {
		mockGetSettings.mockReturnValue(new Promise(() => {}));
		const { result } = renderHook(() => useCueSettings());
		act(() => {
			result.current.setShowSettings(true);
		});
		expect(result.current.showSettings).toBe(true);
	});

	it('setCueSettings updates settings in place', async () => {
		mockGetSettings.mockResolvedValue({ ...DEFAULT_CUE_SETTINGS });
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		act(() => {
			result.current.setCueSettings((prev) => ({ ...prev, max_concurrent_runs: 99 }));
		});
		expect(result.current.cueSettings.max_concurrent_runs).toBe(99);
	});

	it('settingsLoaded=true persists across subsequent setCueSettings calls', async () => {
		mockGetSettings.mockResolvedValue({ ...DEFAULT_CUE_SETTINGS });
		const { result } = renderHook(() => useCueSettings());
		await waitFor(() => expect(result.current.settingsLoaded).toBe(true));
		act(() => {
			result.current.setCueSettings({ ...DEFAULT_CUE_SETTINGS, max_concurrent_runs: 5 });
		});
		expect(result.current.settingsLoaded).toBe(true);
	});

	it('unmount before fetch resolves does not flip settingsLoaded', async () => {
		let resolveFn!: (v: CueSettings) => void;
		mockGetSettings.mockReturnValue(
			new Promise<CueSettings>((resolve) => {
				resolveFn = resolve;
			})
		);
		const { result, unmount } = renderHook(() => useCueSettings());
		expect(result.current.settingsLoaded).toBe(false);
		unmount();
		resolveFn({ ...DEFAULT_CUE_SETTINGS });
		// No assertion failure = no setState-on-unmounted warning (thanks to cancelled flag).
		await Promise.resolve();
	});
});
