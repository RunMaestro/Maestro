/**
 * useAgentClaudeModeResolvedListener — registers
 * `window.maestro.process.onClaudeModeResolved`.
 *
 * Mirrors the spawner's headless-mode decision back into the renderer:
 * stamps `session.claudeInteractive.{mode, modeReason, lastUsageSnapshotKey}`
 * so the popover and reactive replay flow stay in sync with the process.
 *
 * When the resolver flips from Time Limits → API Limits with reason
 * `'limit'` mid-conversation, also:
 *   - Fires a toast so the user sees the switch immediately.
 *   - Inserts a system-source `LogEntry` into the active AI tab so the
 *     transition shows up in the chat history right where it happened.
 *
 * Skips both side effects when the persisted state already matches the
 * incoming resolution — avoids gratuitous re-renders on routine spawns
 * and duplicate banners if the IPC re-emits.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useClaudeUsageStore } from '../../../stores/claudeUsageStore';
import { notifyToast } from '../../../stores/notificationStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { generateId } from '../../../utils/ids';
import type { LogEntry } from '../../../types';

function buildBatchModeBanner(
	prevMode: 'interactive' | 'api' | undefined,
	resolvedMode: 'interactive' | 'api',
	reason: 'auto' | 'limit'
): LogEntry {
	const prevLabel = prevMode === 'interactive' ? 'Time Limits' : 'API Limits';
	const nextLabel = resolvedMode === 'interactive' ? 'Time Limits' : 'API Limits';
	const why = reason === 'limit' ? 'Max plan 5-hour or weekly quota hit.' : 'Quota windows reset.';
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		text: `Adaptive Mode: switched from ${prevLabel} to ${nextLabel}. ${why}`,
	};
}

export function useAgentClaudeModeResolvedListener(): void {
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;

		const unsubscribe = window.maestro.process.onClaudeModeResolved?.(
			(
				sessionId: string,
				resolution: {
					mode: 'interactive' | 'api';
					reason: 'auto' | 'limit';
					configDirKey: string;
				}
			) => {
				// Strip the tab/role suffix the spawner uses for AI tabs so we land
				// on the parent session that actually owns `claudeInteractive`.
				let actualSessionId: string;
				const aiTabMatch = sessionId.match(REGEX_AI_TAB);
				if (aiTabMatch) {
					actualSessionId = aiTabMatch[1];
				} else if (sessionId.endsWith('-ai') || sessionId.endsWith('-terminal')) {
					actualSessionId = sessionId.replace(/-ai$|-terminal$/, '');
				} else {
					actualSessionId = sessionId;
				}

				let transitionedToLimit = false;
				let transitionedBackToInteractive = false;
				let bannerEntry: LogEntry | null = null;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const current = s.claudeInteractive;
						if (
							current &&
							current.mode === resolution.mode &&
							current.modeReason === resolution.reason &&
							current.lastUsageSnapshotKey === resolution.configDirKey
						) {
							return s;
						}

						// Detect a meaningful mode flip — this is what triggers the
						// toast + inline banner. Banners and toasts are framed as
						// "Adaptive Mode: switched ..." so they only make sense for
						// sessions that actually have Adaptive Mode on. Sessions that
						// resolve `interactive` because the user wired `Path` directly
						// at maestro-p (toggle off), and stale-state cleanup writes,
						// also flow through this listener but must not fire the
						// Adaptive-Mode-flavoured UI.
						const modeChanged = current?.mode !== resolution.mode;
						const adaptiveModeOn = s.enableMaestroP === true;
						if (
							adaptiveModeOn &&
							modeChanged &&
							resolution.mode === 'api' &&
							resolution.reason === 'limit'
						) {
							transitionedToLimit = true;
						}
						if (adaptiveModeOn && modeChanged && resolution.mode === 'interactive') {
							transitionedBackToInteractive = true;
						}
						if (adaptiveModeOn && modeChanged && bannerEntry === null) {
							bannerEntry = buildBatchModeBanner(current?.mode, resolution.mode, resolution.reason);
						}

						const nextSession = {
							...s,
							claudeInteractive: {
								mode: resolution.mode,
								modeReason: resolution.reason,
								lastUsageSnapshotKey: resolution.configDirKey,
							},
						};

						// Splice the banner into the active AI tab's logs so it
						// shows up in chat history at the point of transition.
						if (bannerEntry && s.activeTabId && s.aiTabs?.length) {
							const banner = bannerEntry;
							nextSession.aiTabs = s.aiTabs.map((tab) =>
								tab.id === s.activeTabId ? { ...tab, logs: [...tab.logs, banner] } : tab
							);
						}

						return nextSession;
					})
				);

				if (transitionedToLimit) {
					notifyToast({
						color: 'yellow',
						title: 'Switched to API Limits',
						message: 'Max plan quota hit — falling back to billed API for this turn.',
					});
				} else if (transitionedBackToInteractive) {
					notifyToast({
						color: 'green',
						title: 'Switched to Time Limits',
						message: 'Max plan quota window has reset — back on Time Limits.',
					});
				}

				// The mode resolver may have re-sampled usage as part of its
				// decision — pull the latest snapshot map so the popover bars
				// reflect the same numbers the spawner just acted on.
				void useClaudeUsageStore.getState().refresh();
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, []);
}
