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
 *   - SpecKit + OpenSpec command loading
 *   - SSH remote configs loading
 *   - Stats DB corruption check
 *   - Notification settings sync to notificationStore
 *   - Playground debug function exposure
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SpecKitCommand, OpenSpecCommand } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';
import { useTabStore } from '../../stores/tabStore';
import { useNotificationStore, notifyToast } from '../../stores/notificationStore';
import { getSpeckitCommands } from '../../services/speckit';
import { getOpenSpecCommands } from '../../services/openspec';
import { exposeWindowsWarningModalDebug } from '../../components/WindowsWarningModal';
import type { GistInfo } from '../../components/GistPublishModal';

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
	const suppressWindowsWarning = useSettingsStore((s) => s.suppressWindowsWarning);
	const enableBetaUpdates = useSettingsStore((s) => s.enableBetaUpdates);
	const checkForUpdatesOnStartup = useSettingsStore((s) => s.checkForUpdatesOnStartup);
	const leaderboardAuthToken = useSettingsStore((s) => s.leaderboardRegistration?.authToken);
	const toastDuration = useSettingsStore((s) => s.toastDuration);
	const audioFeedbackEnabled = useSettingsStore((s) => s.audioFeedbackEnabled);
	const audioFeedbackCommand = useSettingsStore((s) => s.audioFeedbackCommand);
	const osNotificationsEnabled = useSettingsStore((s) => s.osNotificationsEnabled);

	// --- Local state ---
	const [ghCliAvailable, setGhCliAvailable] = useState(false);
	const [sshRemoteConfigs, setSshRemoteConfigs] = useState<Array<{ id: string; name: string }>>([]);
	const [speckitCommands, setSpeckitCommands] = useState<SpecKitCommand[]>([]);
	const [openspecCommands, setOpenspecCommands] = useState<OpenSpecCommand[]>([]);

	// --- Splash screen coordination ---
	// Progress stages: 0-40% React bootstrap (splash.js), 40-60% settings,
	// 60-80% sessions, 80-95% UI rendering, 95-100% ready.
	// We wait for the React tree to paint with loaded data before dismissing,
	// so the user doesn't see an unresponsive interface.
	useEffect(() => {
		if (settingsLoaded && !sessionsLoaded) {
			window.__updateSplash?.(60, 'Warming up the ensemble...');
		}
		if (!settingsLoaded && sessionsLoaded) {
			window.__updateSplash?.(60, 'Warming up the ensemble...');
		}
		if (settingsLoaded && sessionsLoaded) {
			window.__updateSplash?.(80, 'The concertmaster rises...');
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
	}, [settingsLoaded, sessionsLoaded]);

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
				console.error('[App] Failed to detect platform for Windows warning:', error);
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
				console.debug('[useAppInitialization] Failed to load fileGistUrls:', error);
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

	// --- Check for updates on startup ---
	useEffect(() => {
		if (settingsLoaded && checkForUpdatesOnStartup) {
			const timer = setTimeout(async () => {
				try {
					const result = await window.maestro.updates.check(enableBetaUpdates);
					if (result.updateAvailable && !result.error) {
						getModalActions().setUpdateCheckModalOpen(true);
					}
				} catch (error) {
					console.error('Failed to check for updates on startup:', error);
				}
			}, 2000);
			return () => clearTimeout(timer);
		}
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
				console.debug('[Leaderboard] Startup sync failed (non-critical):', error);
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
				console.error('[SpecKit] Failed to load commands:', error);
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
				console.error('[OpenSpec] Failed to load commands:', error);
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
				console.warn('[useAppInitialization] Failed to load SSH remote configs:', error);
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
		saveFileGistUrl,
	};
}
