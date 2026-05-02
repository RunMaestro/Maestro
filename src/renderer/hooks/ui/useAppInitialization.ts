/**
 * useAppInitialization — extracted from App.tsx (Phase 2G)
 *
 * Owns one-time startup effects that run on mount or when settings load.
 * Reads from Zustand stores via selectors for React-driven effects.
 *
 * Effects:
 *   - Splash screen coordination (wait for settings + sessions)
 *   - GitHub CLI availability check
 *   - Windows warning modal for Windows users
 *   - File gist URLs loading from settings
 *   - Beta updates setting sync
 *   - Update check on startup
 *   - Leaderboard stats sync from server
 *   - SpecKit + OpenSpec + BMAD command loading
 *   - SSH remote configs loading
 *   - Stats DB corruption check
 *   - Notification settings sync to notificationStore
 *   - Playground debug function exposure
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpecKitCommand, OpenSpecCommand, BmadCommand } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';
import { useTabStore } from '../../stores/tabStore';
import { useNotificationStore, notifyToast } from '../../stores/notificationStore';
import { getSpeckitCommands } from '../../services/speckit';
import { getOpenSpecCommands } from '../../services/openspec';
import { getBmadCommands } from '../../services/bmad';
import { captureException } from '../../utils/sentry';
import { exposeWindowsWarningModalDebug } from '../../components/WindowsWarningModal';
import type { GistInfo } from '../../components/GistPublishModal';
import { logger } from '../../utils/logger';

// ============================================================================
// Return type
// ============================================================================

export interface AppInitializationReturn {
	/** Whether GitHub CLI is installed and authenticated */
	ghCliAvailable: boolean;
	/** SSH remote configurations for participant cards */
	sshRemoteConfigs: Array<{ id: string; name: string }>;
	/** Loaded SpecKit commands */
	speckitCommands: SpecKitCommand[];
	/** Loaded OpenSpec commands */
	openspecCommands: OpenSpecCommand[];
	/** Loaded BMAD commands */
	bmadCommands: BmadCommand[];
	/** Save a gist URL for a file path (persisted to settings) */
	saveFileGistUrl: (filePath: string, gistInfo: GistInfo) => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useAppInitialization(): AppInitializationReturn {
	// --- Store selectors ---
	const settingsLoaded = useSettingsStore((s) => s.settingsLoaded);
	const sessionsLoaded = useSessionStore((s) => s.sessionsLoaded);
	const initialFileTreeReady = useSessionStore((s) => s.initialFileTreeReady);
	const suppressWindowsWarning = useSettingsStore((s) => s.suppressWindowsWarning);
	const enableBetaUpdates = useSettingsStore((s) => s.enableBetaUpdates);
	const checkForUpdatesOnStartup = useSettingsStore((s) => s.checkForUpdatesOnStartup);
	const leaderboardAuthToken = useSettingsStore((s) => s.leaderboardRegistration?.authToken);
	const toastDuration = useSettingsStore((s) => s.toastDuration);
	const audioFeedbackEnabled = useSettingsStore((s) => s.audioFeedbackEnabled);
	const audioFeedbackCommand = useSettingsStore((s) => s.audioFeedbackCommand);
	const osNotificationsEnabled = useSettingsStore((s) => s.osNotificationsEnabled);
	const idleNotificationEnabled = useSettingsStore((s) => s.idleNotificationEnabled);
	const idleNotificationCommand = useSettingsStore((s) => s.idleNotificationCommand);

	// --- Local state ---
	const [ghCliAvailable, setGhCliAvailable] = useState(false);
	const [sshRemoteConfigs, setSshRemoteConfigs] = useState<Array<{ id: string; name: string }>>([]);
	const [speckitCommands, setSpeckitCommands] = useState<SpecKitCommand[]>([]);
	const [openspecCommands, setOpenspecCommands] = useState<OpenSpecCommand[]>([]);
	const [bmadCommands, setBmadCommands] = useState<BmadCommand[]>([]);

	// --- Splash screen coordination ---
	// Progress stages: 0-40% React bootstrap (splash.js), 40-60% settings,
	// 60-80% sessions, 80-90% file tree, 90-95% UI rendering, 95-100% ready.
	// We wait for settings, sessions, AND the initial file tree load before
	// dismissing, so the user doesn't see "Loading files..." or an unresponsive UI.
	useEffect(() => {
		if (settingsLoaded && !sessionsLoaded) {
			window.__updateSplash?.(60, 'Warming up the ensemble...');
		}
		if (!settingsLoaded && sessionsLoaded) {
			window.__updateSplash?.(60, 'Warming up the ensemble...');
		}
		if (settingsLoaded && sessionsLoaded && !initialFileTreeReady) {
			window.__updateSplash?.(80, 'Indexing the score...');
		}
		if (settingsLoaded && sessionsLoaded && initialFileTreeReady) {
			window.__updateSplash?.(90, 'The concertmaster rises...');
			// Wait for React to render the UI with loaded data before hiding splash.
			// Double rAF ensures at least one full paint cycle has completed,
			// then a short delay lets the file tree and heavy components settle.
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					window.__updateSplash?.(95, 'Maestro takes the podium...');
					setTimeout(() => {
						window.__hideSplash?.();
					}, 150);
				});
			});
		}
	}, [settingsLoaded, sessionsLoaded, initialFileTreeReady]);

	// --- GitHub CLI availability check ---
	useEffect(() => {
		window.maestro.git
			.checkGhCli()
			.then((status) => {
				setGhCliAvailable(status.installed && status.authenticated);
			})
			.catch(() => {
				setGhCliAvailable(false);
			});
	}, []);

	// --- Windows warning modal ---
	const windowsWarningShownRef = useRef(false);
	useEffect(() => {
		const { setWindowsWarningModalOpen } = getModalActions();
		exposeWindowsWarningModalDebug(setWindowsWarningModalOpen);

		if (!settingsLoaded) return;
		if (suppressWindowsWarning) return;
		if (windowsWarningShownRef.current) return;

		window.maestro.power
			.getStatus()
			.then((status) => {
				if (status.platform === 'win32') {
					windowsWarningShownRef.current = true;
					setWindowsWarningModalOpen(true);
				}
			})
			.catch((error) => {
				logger.error('[App] Failed to detect platform for Windows warning:', undefined, error);
			});
	}, [settingsLoaded, suppressWindowsWarning]);

	// --- Load file gist URLs from settings ---
	useEffect(() => {
		window.maestro.settings
			.get('fileGistUrls')
			.then((savedUrls) => {
				if (savedUrls && typeof savedUrls === 'object') {
					useTabStore.getState().setFileGistUrls(savedUrls as Record<string, GistInfo>);
				}
			})
			.catch((error) => {
				logger.debug('[useAppInitialization] Failed to load fileGistUrls:', undefined, error);
			});
	}, []);

	// --- Save file gist URL helper ---
	const saveFileGistUrl = useCallback((filePath: string, gistInfo: GistInfo) => {
		const { fileGistUrls: current } = useTabStore.getState();
		const updated = { ...current, [filePath]: gistInfo };
		useTabStore.getState().setFileGistUrls(updated);
		window.maestro.settings.set('fileGistUrls', updated);
	}, []);

	// --- Sync beta updates setting to electron-updater ---
	useEffect(() => {
		if (settingsLoaded) {
			window.maestro.updates.setAllowPrerelease(enableBetaUpdates);
		}
	}, [settingsLoaded, enableBetaUpdates]);

	// --- Check for updates on startup, then daily for long-running sessions ---
	useEffect(() => {
		if (!settingsLoaded || !checkForUpdatesOnStartup) return;

		const runCheck = async () => {
			try {
				const result = await window.maestro.updates.check(enableBetaUpdates);
				if (result.updateAvailable && !result.error) {
					getModalActions().setUpdateCheckModalOpen(true);
				}
			} catch (error) {
				logger.error('Failed to check for updates:', undefined, error);
			}
		};

		let intervalId: ReturnType<typeof setInterval> | undefined;
		const timer = setTimeout(() => {
			void runCheck();
			intervalId = setInterval(runCheck, 24 * 60 * 60 * 1000);
		}, 2000);

		return () => {
			clearTimeout(timer);
			if (intervalId) clearInterval(intervalId);
		};
	}, [settingsLoaded, checkForUpdatesOnStartup, enableBetaUpdates]);

	// --- Leaderboard startup sync ---
	useEffect(() => {
		if (!settingsLoaded) return;
		const { leaderboardRegistration } = useSettingsStore.getState();
		const authToken = leaderboardRegistration?.authToken;
		const email = leaderboardRegistration?.email;
		if (!authToken || !email) return;

		const timer = setTimeout(async () => {
			try {
				const result = await window.maestro.leaderboard.sync({ email, authToken });

				if (result.success && result.found && result.data) {
					// Read fresh autoRunStats at call time
					const currentStats = useSettingsStore.getState().autoRunStats;
					if (result.data.cumulativeTimeMs > currentStats.cumulativeTimeMs) {
						const longestRunTimestamp = result.data.longestRunDate
							? new Date(result.data.longestRunDate).getTime()
							: currentStats.longestRunTimestamp;

						useSettingsStore.getState().setAutoRunStats({
							...currentStats,
							cumulativeTimeMs: result.data.cumulativeTimeMs,
							totalRuns: result.data.totalRuns,
							currentBadgeLevel: result.data.badgeLevel,
							longestRunMs: result.data.longestRunMs ?? currentStats.longestRunMs,
							longestRunTimestamp,
							lastBadgeUnlockLevel: result.data.badgeLevel,
							lastAcknowledgedBadgeLevel: result.data.badgeLevel,
						});
					}
				}
			} catch (error) {
				logger.debug('[Leaderboard] Startup sync failed (non-critical):', undefined, error);
			}
		}, 3000);

		return () => clearTimeout(timer);
	}, [settingsLoaded, leaderboardAuthToken]);

	// --- SpecKit commands loading ---
	useEffect(() => {
		(async () => {
			try {
				const commands = await getSpeckitCommands();
				setSpeckitCommands(commands);
			} catch (error) {
				logger.error('[SpecKit] Failed to load commands:', undefined, error);
			}
		})();
	}, []);

	// --- OpenSpec commands loading ---
	useEffect(() => {
		(async () => {
			try {
				const commands = await getOpenSpecCommands();
				setOpenspecCommands(commands);
			} catch (error) {
				logger.error('[OpenSpec] Failed to load commands:', undefined, error);
			}
		})();
	}, []);

	// --- BMAD commands loading ---
	useEffect(() => {
		(async () => {
			try {
				const commands = await getBmadCommands();
				setBmadCommands(commands);
			} catch (error) {
				captureException(error, {
					extra: {
						context: 'useAppInitialization - BMAD load',
					},
				});
			}
		})();
	}, []);

	// --- SSH remote configs loading ---
	// Non-critical: SSH may not be configured. Failures are logged but not
	// reported to Sentry since the app functions fully without SSH remotes.
	useEffect(() => {
		window.maestro?.sshRemote
			?.getConfigs()
			.then((result) => {
				if (result.success && result.configs) {
					setSshRemoteConfigs(
						result.configs.map((c: { id: string; name: string }) => ({
							id: c.id,
							name: c.name,
						}))
					);
				}
			})
			.catch((error) => {
				logger.warn('[useAppInitialization] Failed to load SSH remote configs:', undefined, error);
			});
	}, []);

	// --- Stats DB corruption check ---
	useEffect(() => {
		window.maestro?.stats
			?.getInitializationResult()
			.then((result) => {
				if (result?.userMessage) {
					notifyToast({
						type: 'warning',
						title: 'Statistics Database',
						message: result.userMessage,
						duration: 10000,
					});
					window.maestro?.stats?.clearInitializationResult();
				}
			})
			.catch(console.error);
	}, []);

	// --- Notification settings sync ---
	useEffect(() => {
		useNotificationStore.getState().setDefaultDuration(toastDuration);
	}, [toastDuration]);

	useEffect(() => {
		useNotificationStore.getState().setAudioFeedback(audioFeedbackEnabled, audioFeedbackCommand);
	}, [audioFeedbackEnabled, audioFeedbackCommand]);

	useEffect(() => {
		useNotificationStore.getState().setOsNotifications(osNotificationsEnabled);
	}, [osNotificationsEnabled]);

	useEffect(() => {
		useNotificationStore
			.getState()
			.setIdleNotification(idleNotificationEnabled, idleNotificationCommand);
	}, [idleNotificationEnabled, idleNotificationCommand]);

	// --- Playground debug function ---
	useEffect(() => {
		(window as unknown as { playground: () => void }).playground = () => {
			getModalActions().setPlaygroundOpen(true);
		};
		return () => {
			delete (window as unknown as { playground?: () => void }).playground;
		};
	}, []);

	return {
		ghCliAvailable,
		sshRemoteConfigs,
		speckitCommands,
		openspecCommands,
		bmadCommands,
		saveFileGistUrl,
	};
}
