/**
 * Tests for useAppInitialization hook (Phase 2G)
 *
 * Covers: splash screen, GitHub CLI check, Windows warning, gist URLs,
 * beta updates sync, update check, leaderboard sync, SpecKit/OpenSpec loading,
 * SSH configs, stats DB check, notification sync, playground debug, saveFileGistUrl
 */

import { renderHook, act } from '@testing-library/react';
import { useAppInitialization } from '../../renderer/hooks/ui/useAppInitialization';
import { logger } from '../../renderer/utils/logger';

// ============================================================================
// Mock stores
// ============================================================================

const mockSettingsState: Record<string, unknown> = {
	settingsLoaded: false,
	suppressWindowsWarning: false,
	enableBetaUpdates: false,
	checkForUpdatesOnStartup: false,
	leaderboardRegistration: null,
	toastDuration: 5000,
	audioFeedbackEnabled: false,
	audioFeedbackCommand: '',
	osNotificationsEnabled: false,
	idleNotificationEnabled: false,
	idleNotificationCommand: '',
	speckitEnabled: false,
	openspecEnabled: false,
	bmadEnabled: false,
	autoRunStats: {
		cumulativeTimeMs: 0,
		totalRuns: 0,
		currentBadgeLevel: 0,
		longestRunMs: 0,
		longestRunTimestamp: 0,
		lastBadgeUnlockLevel: 0,
		lastAcknowledgedBadgeLevel: 0,
	},
	setAutoRunStats: vi.fn(),
};

vi.mock('../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector(mockSettingsState),
		{
			getState: () => mockSettingsState,
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));

const mockSessionState: Record<string, unknown> = {
	sessionsLoaded: false,
	initialFileTreeReady: false,
};

vi.mock('../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector(mockSessionState),
		{
			getState: () => mockSessionState,
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));

const mockSetWindowsWarningModalOpen = vi.fn();
const mockSetUpdateCheckModalOpen = vi.fn();
const mockSetPlaygroundOpen = vi.fn();

vi.mock('../../renderer/stores/modalStore', () => ({
	getModalActions: () => ({
		setWindowsWarningModalOpen: mockSetWindowsWarningModalOpen,
		setUpdateCheckModalOpen: mockSetUpdateCheckModalOpen,
		setPlaygroundOpen: mockSetPlaygroundOpen,
	}),
}));

const mockSetFileGistUrls = vi.fn();
const mockTabStoreState: Record<string, unknown> = {
	fileGistUrls: {},
	setFileGistUrls: mockSetFileGistUrls,
};

vi.mock('../../renderer/stores/tabStore', () => ({
	useTabStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector(mockTabStoreState),
		{
			getState: () => mockTabStoreState,
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));

const mockSetDefaultDuration = vi.fn();
const mockSetAudioFeedback = vi.fn();
const mockSetOsNotifications = vi.fn();
const mockSetIdleNotification = vi.fn();

vi.mock('../../renderer/stores/notificationStore', () => ({
	useNotificationStore: Object.assign(vi.fn(), {
		getState: () => ({
			setDefaultDuration: mockSetDefaultDuration,
			setAudioFeedback: mockSetAudioFeedback,
			setOsNotifications: mockSetOsNotifications,
			setIdleNotification: mockSetIdleNotification,
		}),
		setState: vi.fn(),
		subscribe: vi.fn(() => vi.fn()),
	}),
	notifyToast: vi.fn(),
}));

// ============================================================================
// Mock services
// ============================================================================

const mockSpeckitCommands = [
	{ name: 'speckit-cmd-1', prompt: 'test prompt 1', description: 'desc 1' },
];
const mockOpenspecCommands = [
	{ name: 'openspec-cmd-1', prompt: 'test prompt 2', description: 'desc 2' },
];

vi.mock('../../renderer/services/speckit', () => ({
	getSpeckitCommands: vi.fn(() => Promise.resolve(mockSpeckitCommands)),
}));

vi.mock('../../renderer/services/openspec', () => ({
	getOpenSpecCommands: vi.fn(() => Promise.resolve(mockOpenspecCommands)),
}));

// ============================================================================
// Mock components
// ============================================================================

const mockExposeWindowsWarningModalDebug = vi.fn();
vi.mock('../../renderer/components/WindowsWarningModal', () => ({
	exposeWindowsWarningModalDebug: (...args: unknown[]) =>
		mockExposeWindowsWarningModalDebug(...args),
}));

// ============================================================================
// Mock window.maestro
// ============================================================================

const mockCheckGhCli = vi.fn();
const mockGetStatus = vi.fn();
const mockSettingsGet = vi.fn();
const mockSettingsSet = vi.fn();
const mockSetAllowPrerelease = vi.fn();
const mockUpdatesCheck = vi.fn();
const mockLeaderboardSync = vi.fn();
const mockGetSshConfigs = vi.fn();
const mockGetInitializationResult = vi.fn();
const mockClearInitializationResult = vi.fn();

beforeAll(() => {
	(window as any).maestro = {
		git: { checkGhCli: mockCheckGhCli },
		power: { getStatus: mockGetStatus },
		settings: { get: mockSettingsGet, set: mockSettingsSet },
		updates: { setAllowPrerelease: mockSetAllowPrerelease, check: mockUpdatesCheck },
		leaderboard: { sync: mockLeaderboardSync },
		sshRemote: { getConfigs: mockGetSshConfigs },
		stats: {
			getInitializationResult: mockGetInitializationResult,
			clearInitializationResult: mockClearInitializationResult,
		},
	};
	(window as any).__hideSplash = vi.fn();
});

// ============================================================================
// Helpers
// ============================================================================

function resetStores() {
	mockSettingsState.settingsLoaded = false;
	mockSettingsState.suppressWindowsWarning = false;
	mockSettingsState.enableBetaUpdates = false;
	mockSettingsState.checkForUpdatesOnStartup = false;
	mockSettingsState.leaderboardRegistration = null;
	mockSettingsState.toastDuration = 5000;
	mockSettingsState.audioFeedbackEnabled = false;
	mockSettingsState.audioFeedbackCommand = '';
	mockSettingsState.osNotificationsEnabled = false;
	mockSettingsState.idleNotificationEnabled = false;
	mockSettingsState.idleNotificationCommand = '';
	mockSettingsState.speckitEnabled = false;
	mockSettingsState.openspecEnabled = false;
	mockSettingsState.bmadEnabled = false;
	mockSettingsState.autoRunStats = {
		cumulativeTimeMs: 0,
		totalRuns: 0,
		currentBadgeLevel: 0,
		longestRunMs: 0,
		longestRunTimestamp: 0,
		lastBadgeUnlockLevel: 0,
		lastAcknowledgedBadgeLevel: 0,
	};

	mockSessionState.sessionsLoaded = false;
	mockSessionState.initialFileTreeReady = false;
	mockTabStoreState.fileGistUrls = {};
}

function flushPromises() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleInitializationEffects() {
	await act(flushPromises);
}

beforeEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
	resetStores();
	mockCheckGhCli.mockResolvedValue({ installed: false, authenticated: false });
	mockGetStatus.mockResolvedValue({ platform: 'darwin' });
	mockSettingsGet.mockResolvedValue(null);
	mockUpdatesCheck.mockResolvedValue({ updateAvailable: false });
	mockLeaderboardSync.mockResolvedValue({ success: false });
	mockGetSshConfigs.mockResolvedValue({ success: false, configs: [] });
	mockGetInitializationResult.mockResolvedValue(null);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

// ============================================================================
// Tests
// ============================================================================

describe('useAppInitialization', () => {
	// --- Return values ---
	describe('initial return values', () => {
		it('should return default values on mount', async () => {
			const { result } = renderHook(() => useAppInitialization());

			expect(result.current.ghCliAvailable).toBe(false);
			expect(result.current.sshRemoteConfigs).toEqual([]);
			expect(result.current.speckitCommands).toEqual([]);
			expect(result.current.openspecCommands).toEqual([]);
			expect(typeof result.current.saveFileGistUrl).toBe('function');

			await settleInitializationEffects();
		});
	});

	// --- Splash screen ---
	describe('splash screen coordination', () => {
		it('should not call __hideSplash when settings are not loaded', async () => {
			mockSettingsState.settingsLoaded = false;
			mockSessionState.sessionsLoaded = true;
			renderHook(() => useAppInitialization());

			expect((window as any).__hideSplash).not.toHaveBeenCalled();
			await settleInitializationEffects();
		});

		it('should not call __hideSplash when sessions are not loaded', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSessionState.sessionsLoaded = false;
			renderHook(() => useAppInitialization());

			expect((window as any).__hideSplash).not.toHaveBeenCalled();
			await settleInitializationEffects();
		});

		it('should call __hideSplash when both settings and sessions are loaded', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSessionState.sessionsLoaded = true;
			mockSessionState.initialFileTreeReady = true;
			renderHook(() => useAppInitialization());

			act(() => {
				vi.advanceTimersByTime(200);
			});

			expect((window as any).__hideSplash).toHaveBeenCalledTimes(1);
			vi.useRealTimers();
			await settleInitializationEffects();
		});

		it('should not throw when splash hide callback is unavailable', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSessionState.sessionsLoaded = true;
			mockSessionState.initialFileTreeReady = true;
			const originalHideSplash = (window as any).__hideSplash;
			delete (window as any).__hideSplash;

			try {
				expect(() => renderHook(() => useAppInitialization())).not.toThrow();
				act(() => {
					vi.advanceTimersByTime(200);
				});
				vi.useRealTimers();
				await settleInitializationEffects();
			} finally {
				vi.useRealTimers();
				(window as any).__hideSplash = originalHideSplash;
			}
		});
	});

	// --- GitHub CLI ---
	describe('GitHub CLI availability check', () => {
		it('should set ghCliAvailable to true when installed and authenticated', async () => {
			mockCheckGhCli.mockResolvedValue({ installed: true, authenticated: true });
			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.ghCliAvailable).toBe(true);
		});

		it('should set ghCliAvailable to false when not installed', async () => {
			mockCheckGhCli.mockResolvedValue({ installed: false, authenticated: false });
			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.ghCliAvailable).toBe(false);
		});

		it('should set ghCliAvailable to false when installed but not authenticated', async () => {
			mockCheckGhCli.mockResolvedValue({ installed: true, authenticated: false });
			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.ghCliAvailable).toBe(false);
		});

		it('should handle checkGhCli error gracefully', async () => {
			mockCheckGhCli.mockRejectedValue(new Error('failed'));
			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.ghCliAvailable).toBe(false);
		});
	});

	// --- Windows warning modal ---
	describe('Windows warning modal', () => {
		it('should expose debug function for Windows warning modal', async () => {
			renderHook(() => useAppInitialization());

			expect(mockExposeWindowsWarningModalDebug).toHaveBeenCalledWith(
				mockSetWindowsWarningModalOpen
			);
			await settleInitializationEffects();
		});

		it('should not show Windows warning when settings not loaded', async () => {
			mockSettingsState.settingsLoaded = false;
			mockGetStatus.mockResolvedValue({ platform: 'win32' });
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetWindowsWarningModalOpen).not.toHaveBeenCalledWith(true);
		});

		it('should not show Windows warning when suppressed', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.suppressWindowsWarning = true;
			mockGetStatus.mockResolvedValue({ platform: 'win32' });
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetWindowsWarningModalOpen).not.toHaveBeenCalledWith(true);
		});

		it('should show Windows warning on Windows platform', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.suppressWindowsWarning = false;
			mockGetStatus.mockResolvedValue({ platform: 'win32' });
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetWindowsWarningModalOpen).toHaveBeenCalledWith(true);
		});

		it('should only show Windows warning once when suppression toggles', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.suppressWindowsWarning = false;
			mockGetStatus.mockResolvedValue({ platform: 'win32' });
			const { rerender } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			mockSettingsState.suppressWindowsWarning = true;
			rerender();
			await act(flushPromises);

			mockSettingsState.suppressWindowsWarning = false;
			rerender();
			await act(flushPromises);

			expect(mockGetStatus).toHaveBeenCalledTimes(1);
			expect(mockSetWindowsWarningModalOpen).toHaveBeenCalledTimes(1);
			expect(mockSetWindowsWarningModalOpen).toHaveBeenCalledWith(true);
		});

		it('should not show Windows warning on non-Windows platform', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.suppressWindowsWarning = false;
			mockGetStatus.mockResolvedValue({ platform: 'darwin' });
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetWindowsWarningModalOpen).not.toHaveBeenCalledWith(true);
		});

		it('should handle platform detection error gracefully', async () => {
			const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
			mockSettingsState.settingsLoaded = true;
			const error = new Error('platform error');
			mockGetStatus.mockRejectedValue(error);
			renderHook(() => useAppInitialization());
			await settleInitializationEffects();

			expect(mockSetWindowsWarningModalOpen).not.toHaveBeenCalledWith(true);
			expect(loggerError).toHaveBeenCalledWith(
				'[App] Failed to detect platform for Windows warning:',
				undefined,
				error
			);
			loggerError.mockRestore();
		});
	});

	// --- File gist URLs ---
	describe('file gist URL loading', () => {
		it('should load file gist URLs from settings on mount', async () => {
			const savedUrls = { 'file.ts': { url: 'https://gist.github.com/123', id: '123' } };
			mockSettingsGet.mockResolvedValue(savedUrls);
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSettingsGet).toHaveBeenCalledWith('fileGistUrls');
			expect(mockSetFileGistUrls).toHaveBeenCalledWith(savedUrls);
		});

		it('should not set gist URLs if settings returns null', async () => {
			mockSettingsGet.mockResolvedValue(null);
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetFileGistUrls).not.toHaveBeenCalled();
		});

		it('should handle gist URL loading error gracefully', async () => {
			const loggerDebug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
			const error = new Error('load error');
			mockSettingsGet.mockRejectedValue(error);
			renderHook(() => useAppInitialization());
			await settleInitializationEffects();

			expect(mockSetFileGistUrls).not.toHaveBeenCalled();
			expect(loggerDebug).toHaveBeenCalledWith(
				'[useAppInitialization] Failed to load fileGistUrls:',
				undefined,
				error
			);
			loggerDebug.mockRestore();
		});
	});

	// --- saveFileGistUrl ---
	describe('saveFileGistUrl', () => {
		it('should update tab store and persist to settings', async () => {
			mockTabStoreState.fileGistUrls = { 'existing.ts': { url: 'https://old', id: 'old' } };
			const { result } = renderHook(() => useAppInitialization());
			const gistInfo = { url: 'https://gist.github.com/456', id: '456' };

			act(() => {
				result.current.saveFileGistUrl('new.ts', gistInfo as any);
			});

			expect(mockSetFileGistUrls).toHaveBeenCalledWith({
				'existing.ts': { url: 'https://old', id: 'old' },
				'new.ts': gistInfo,
			});
			expect(mockSettingsSet).toHaveBeenCalledWith('fileGistUrls', {
				'existing.ts': { url: 'https://old', id: 'old' },
				'new.ts': gistInfo,
			});

			await settleInitializationEffects();
		});
	});

	// --- Beta updates sync ---
	describe('beta updates sync', () => {
		it('should sync beta updates setting when settings loaded', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.enableBetaUpdates = true;
			renderHook(() => useAppInitialization());

			expect(mockSetAllowPrerelease).toHaveBeenCalledWith(true);
			await settleInitializationEffects();
		});

		it('should not sync beta updates when settings not loaded', async () => {
			mockSettingsState.settingsLoaded = false;
			mockSettingsState.enableBetaUpdates = true;
			renderHook(() => useAppInitialization());

			expect(mockSetAllowPrerelease).not.toHaveBeenCalled();
			await settleInitializationEffects();
		});
	});

	// --- Update check on startup ---
	describe('update check on startup', () => {
		it('should check for updates when enabled and settings loaded', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.checkForUpdatesOnStartup = true;
			mockUpdatesCheck.mockResolvedValue({ updateAvailable: true });

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2500);
			});

			expect(mockUpdatesCheck).toHaveBeenCalled();
			expect(mockSetUpdateCheckModalOpen).toHaveBeenCalledWith(true);
		});

		it('should not check for updates when disabled', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.checkForUpdatesOnStartup = false;
			renderHook(() => useAppInitialization());

			expect(mockUpdatesCheck).not.toHaveBeenCalled();
			await settleInitializationEffects();
		});

		it('should not open modal when no update available', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.checkForUpdatesOnStartup = true;
			mockUpdatesCheck.mockResolvedValue({ updateAvailable: false });

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2500);
			});

			expect(mockSetUpdateCheckModalOpen).not.toHaveBeenCalled();
		});

		it('should handle update check error gracefully', async () => {
			vi.useFakeTimers();
			const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.checkForUpdatesOnStartup = true;
			const error = new Error('check failed');
			mockUpdatesCheck.mockRejectedValue(error);

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2500);
			});

			expect(mockSetUpdateCheckModalOpen).not.toHaveBeenCalled();
			expect(loggerError).toHaveBeenCalledWith('Failed to check for updates:', undefined, error);
			loggerError.mockRestore();
		});
	});

	// --- Leaderboard startup sync ---
	describe('leaderboard startup sync', () => {
		it('should sync stats from server when registered', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.leaderboardRegistration = {
				authToken: 'token123',
				email: 'user@example.com',
			};
			mockSettingsState.autoRunStats = {
				cumulativeTimeMs: 100,
				totalRuns: 1,
				currentBadgeLevel: 0,
				longestRunMs: 50,
				longestRunTimestamp: 0,
				lastBadgeUnlockLevel: 0,
				lastAcknowledgedBadgeLevel: 0,
			};
			mockLeaderboardSync.mockResolvedValue({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 500,
					totalRuns: 5,
					badgeLevel: 2,
					longestRunMs: 200,
					longestRunDate: '2024-01-01',
				},
			});

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3500);
			});

			expect(mockLeaderboardSync).toHaveBeenCalledWith({
				email: 'user@example.com',
				authToken: 'token123',
			});
			expect(mockSettingsState.setAutoRunStats).toHaveBeenCalled();
		});

		it('should use current longest-run values when synced data omits them', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.leaderboardRegistration = {
				authToken: 'token123',
				email: 'user@example.com',
			};
			mockSettingsState.autoRunStats = {
				cumulativeTimeMs: 100,
				totalRuns: 1,
				currentBadgeLevel: 0,
				longestRunMs: 50,
				longestRunTimestamp: 123456,
				lastBadgeUnlockLevel: 0,
				lastAcknowledgedBadgeLevel: 0,
			};
			mockLeaderboardSync.mockResolvedValue({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 500,
					totalRuns: 5,
					badgeLevel: 2,
				},
			});

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3500);
			});

			expect(mockSettingsState.setAutoRunStats).toHaveBeenCalledWith(
				expect.objectContaining({
					cumulativeTimeMs: 500,
					longestRunMs: 50,
					longestRunTimestamp: 123456,
				})
			);
		});

		it('should not update stats when sync response has no server data', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.leaderboardRegistration = {
				authToken: 'token123',
				email: 'user@example.com',
			};
			mockLeaderboardSync.mockResolvedValue({
				success: true,
				found: false,
				data: null,
			});

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3500);
			});

			expect(mockLeaderboardSync).toHaveBeenCalledWith({
				email: 'user@example.com',
				authToken: 'token123',
			});
			expect(mockSettingsState.setAutoRunStats).not.toHaveBeenCalled();
		});

		it('should not sync when no auth token', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.leaderboardRegistration = { email: 'user@example.com' };

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3500);
			});

			expect(mockLeaderboardSync).not.toHaveBeenCalled();
		});

		it('should not update when server stats are lower', async () => {
			vi.useFakeTimers();
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.leaderboardRegistration = {
				authToken: 'token123',
				email: 'user@example.com',
			};
			mockSettingsState.autoRunStats = {
				cumulativeTimeMs: 1000,
				totalRuns: 10,
				currentBadgeLevel: 3,
				longestRunMs: 500,
				longestRunTimestamp: 0,
				lastBadgeUnlockLevel: 3,
				lastAcknowledgedBadgeLevel: 3,
			};
			mockLeaderboardSync.mockResolvedValue({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 500,
					totalRuns: 5,
					badgeLevel: 2,
				},
			});

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3500);
			});

			expect(mockSettingsState.setAutoRunStats).not.toHaveBeenCalled();
		});

		it('should handle sync failure gracefully', async () => {
			vi.useFakeTimers();
			const loggerDebug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.leaderboardRegistration = {
				authToken: 'token123',
				email: 'user@example.com',
			};
			const error = new Error('sync failed');
			mockLeaderboardSync.mockRejectedValue(error);

			renderHook(() => useAppInitialization());

			await act(async () => {
				await vi.advanceTimersByTimeAsync(3500);
			});

			// Should not throw
			expect(mockSettingsState.setAutoRunStats).not.toHaveBeenCalled();
			expect(loggerDebug).toHaveBeenCalledWith(
				'[Leaderboard] Startup sync failed (non-critical):',
				undefined,
				error
			);
			loggerDebug.mockRestore();
		});
	});

	// --- SpecKit commands ---
	describe('SpecKit commands loading', () => {
		it('should load SpecKit commands on mount', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.speckitEnabled = true;
			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.speckitCommands).toEqual(mockSpeckitCommands);
		});

		it('should handle SpecKit loading error gracefully', async () => {
			const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const { getSpeckitCommands } = await import('../../renderer/services/speckit');
			const error = new Error('load failed');
			(getSpeckitCommands as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.speckitEnabled = true;

			const { result } = renderHook(() => useAppInitialization());
			await settleInitializationEffects();

			expect(result.current.speckitCommands).toEqual([]);
			expect(loggerError).toHaveBeenCalledWith(
				'[SpecKit] Failed to load commands:',
				undefined,
				error
			);
			loggerError.mockRestore();
		});
	});

	// --- OpenSpec commands ---
	describe('OpenSpec commands loading', () => {
		it('should load OpenSpec commands on mount', async () => {
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.openspecEnabled = true;
			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.openspecCommands).toEqual(mockOpenspecCommands);
		});

		it('should handle OpenSpec loading error gracefully', async () => {
			const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const { getOpenSpecCommands } = await import('../../renderer/services/openspec');
			const error = new Error('load failed');
			(getOpenSpecCommands as ReturnType<typeof vi.fn>).mockRejectedValueOnce(error);
			mockSettingsState.settingsLoaded = true;
			mockSettingsState.openspecEnabled = true;

			const { result } = renderHook(() => useAppInitialization());
			await settleInitializationEffects();

			expect(result.current.openspecCommands).toEqual([]);
			expect(loggerError).toHaveBeenCalledWith(
				'[OpenSpec] Failed to load commands:',
				undefined,
				error
			);
			loggerError.mockRestore();
		});
	});

	// --- SSH remote configs ---
	describe('SSH remote configs loading', () => {
		it('should load SSH configs on mount', async () => {
			const configs = [
				{ id: 'remote-1', name: 'My Server' },
				{ id: 'remote-2', name: 'Dev Box' },
			];
			mockGetSshConfigs.mockResolvedValue({ success: true, configs });

			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.sshRemoteConfigs).toEqual(configs);
		});

		it('should handle SSH config loading failure', async () => {
			mockGetSshConfigs.mockResolvedValue({ success: false, configs: [] });

			const { result } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(result.current.sshRemoteConfigs).toEqual([]);
		});

		it('should handle SSH config loading error', async () => {
			const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const error = new Error('SSH error');
			mockGetSshConfigs.mockRejectedValue(error);

			const { result } = renderHook(() => useAppInitialization());
			await settleInitializationEffects();

			expect(result.current.sshRemoteConfigs).toEqual([]);
			expect(loggerWarn).toHaveBeenCalledWith(
				'[useAppInitialization] Failed to load SSH remote configs:',
				undefined,
				error
			);
			loggerWarn.mockRestore();
		});
	});

	// --- Stats DB corruption check ---
	describe('stats DB corruption check', () => {
		it('should show toast when stats DB has corruption message', async () => {
			const { notifyToast: mockNotifyToast } =
				await import('../../renderer/stores/notificationStore');
			mockGetInitializationResult.mockResolvedValue({
				userMessage: 'Database was reset due to corruption',
			});

			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockNotifyToast).toHaveBeenCalledWith({
				type: 'warning',
				title: 'Statistics Database',
				message: 'Database was reset due to corruption',
				duration: 10000,
			});
			expect(mockClearInitializationResult).toHaveBeenCalled();
		});

		it('should not show toast when no corruption', async () => {
			const { notifyToast: mockNotifyToast } =
				await import('../../renderer/stores/notificationStore');
			mockGetInitializationResult.mockResolvedValue(null);

			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockNotifyToast).not.toHaveBeenCalled();
		});
	});

	// --- Notification settings sync ---
	describe('notification settings sync', () => {
		it('should sync toast duration to notification store', async () => {
			mockSettingsState.toastDuration = 8000;
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetDefaultDuration).toHaveBeenCalledWith(8000);
		});

		it('should sync audio feedback settings', async () => {
			mockSettingsState.audioFeedbackEnabled = true;
			mockSettingsState.audioFeedbackCommand = 'afplay /sound.wav';
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetAudioFeedback).toHaveBeenCalledWith(true, 'afplay /sound.wav');
		});

		it('should sync OS notifications setting', async () => {
			mockSettingsState.osNotificationsEnabled = true;
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetOsNotifications).toHaveBeenCalledWith(true);
		});

		it('should sync idle notification settings', async () => {
			mockSettingsState.idleNotificationEnabled = true;
			mockSettingsState.idleNotificationCommand = 'say done';
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(mockSetIdleNotification).toHaveBeenCalledWith(true, 'say done');
		});
	});

	// --- Playground debug function ---
	describe('playground debug function', () => {
		it('should expose playground() on window', async () => {
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(typeof (window as any).playground).toBe('function');
		});

		it('should open playground when called', async () => {
			renderHook(() => useAppInitialization());
			await act(flushPromises);

			(window as any).playground();

			expect(mockSetPlaygroundOpen).toHaveBeenCalledWith(true);
		});

		it('should clean up playground on unmount', async () => {
			const { unmount } = renderHook(() => useAppInitialization());
			await act(flushPromises);

			expect(typeof (window as any).playground).toBe('function');

			unmount();

			expect((window as any).playground).toBeUndefined();
		});
	});
});
