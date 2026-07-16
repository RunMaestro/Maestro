/**
 * useAgentClaudeModeResolvedListener - registers
 * `window.maestro.process.onClaudeModeResolved`.
 *
 * Mirrors the spawner's headless-mode decision back into the renderer:
 * stamps `session.claudeInteractive.{mode, modeReason, lastUsageSnapshotKey}`
 * on EVERY agent whose turn resolves, so each agent's pill + reactive replay
 * stay in sync with its process.
 *
 * The Dynamic TUI↔API switch is a PER-PROVIDER decision, not per-agent: the
 * resolver reads one usage snapshot per Anthropic account (`configDirKey`), so
 * when the Max-plan quota is hit every agent on that account cascades to API on
 * its next turn. We therefore announce a switch (toast + a one-line system
 * banner in the agent that tripped it) only ONCE per provider transition -
 * tracked in `announcedProviderMode` keyed by `configDirKey` - instead of once
 * per agent. Other agents on the same provider cut over silently.
 *
 * Pure TUI / pure API agents never switch, so they neither announce nor seed
 * the provider tracker (`adaptiveModeOn` gates both).
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { useClaudeUsageStore } from '../../../stores/claudeUsageStore';
import { notifyToast } from '../../../stores/notificationStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { generateId } from '../../../utils/ids';
import { getClaudeTokenMode } from '../../../../shared/claudeTokenMode';
import { useOwnedSessionGate } from './useOwnedSessionGate';
import type { LogEntry } from '../../../types';

/**
 * Last-announced effective mode per provider (`configDirKey`), so the Dynamic
 * switch is announced once per account-wide transition and cascades silently to
 * the other agents on that account. Session-scoped: empty on launch, so the
 * first turn per provider just baselines the mode without a spurious banner.
 */
const announcedProviderMode = new Map<string, 'interactive' | 'api'>();

/**
 * Record a provider's resolved mode and report whether it's an account-wide
 * transition worth announcing exactly once. Pure over {@link announcedProviderMode}:
 *   - first time we see a `configDirKey` → baseline it, do NOT announce (the
 *     switch, if any, happened before this session);
 *   - same mode as last announced → no transition (the cascade: other agents on
 *     the account already followed);
 *   - different mode → transition; caller announces and we update the baseline.
 * Exported (with a reset) for unit tests; not part of the hook's public API.
 */
export function noteProviderModeTransition(
	configDirKey: string,
	mode: 'interactive' | 'api'
): { transitioned: boolean; prevMode?: 'interactive' | 'api' } {
	const prev = announcedProviderMode.get(configDirKey);
	if (prev === undefined || prev === mode) {
		announcedProviderMode.set(configDirKey, mode);
		return { transitioned: false };
	}
	announcedProviderMode.set(configDirKey, mode);
	return { transitioned: true, prevMode: prev };
}

/** Test-only: clear the per-provider announce tracker between cases. */
export function __resetAnnouncedProviderMode(): void {
	announcedProviderMode.clear();
}

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
	const ownedGate = useOwnedSessionGate();
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
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
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

				// Is the agent that just resolved actually running Dynamic mode? Only
				// Dynamic auto-switches; pure TUI / pure API never do, so they must
				// neither announce nor seed the provider tracker.
				const triggeringSession = useSessionStore
					.getState()
					.sessions.find((s) => s.id === actualSessionId);
				const adaptiveModeOn = triggeringSession
					? getClaudeTokenMode(triggeringSession) === 'dynamic'
					: false;

				// Provider-level switch dedup: announce the TUI↔API flip once per
				// account (`configDirKey`) transition. The first Dynamic agent to
				// observe the new mode announces it; every other agent on the same
				// provider updates its own pill silently (the resolver already
				// cascaded them via the shared usage snapshot).
				const { transitioned: providerTransitioned, prevMode: providerPrevMode } = adaptiveModeOn
					? noteProviderModeTransition(resolution.configDirKey, resolution.mode)
					: { transitioned: false as const, prevMode: undefined };

				const bannerEntry: LogEntry | null = providerTransitioned
					? buildBatchModeBanner(providerPrevMode, resolution.mode, resolution.reason)
					: null;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const current = s.claudeInteractive;
						// Nothing to do when the pill state already matches and there's
						// no banner to splice - avoids gratuitous re-renders.
						if (
							!bannerEntry &&
							current &&
							current.mode === resolution.mode &&
							current.modeReason === resolution.reason &&
							current.lastUsageSnapshotKey === resolution.configDirKey
						) {
							return s;
						}

						const nextSession = {
							...s,
							claudeInteractive: {
								mode: resolution.mode,
								modeReason: resolution.reason,
								lastUsageSnapshotKey: resolution.configDirKey,
							},
						};

						// Splice the single per-provider banner into the tripping
						// agent's active AI tab so the switch shows in chat history.
						if (bannerEntry && s.activeTabId && s.aiTabs?.length) {
							nextSession.aiTabs = s.aiTabs.map((tab) =>
								tab.id === s.activeTabId ? { ...tab, logs: [...tab.logs, bannerEntry] } : tab
							);
						}

						return nextSession;
					})
				);

				if (providerTransitioned && resolution.mode === 'api') {
					notifyToast({
						color: 'yellow',
						title: 'Switched to API Limits',
						message: 'Max plan quota hit - agents on this account are falling back to billed API.',
					});
				} else if (providerTransitioned && resolution.mode === 'interactive') {
					notifyToast({
						color: 'green',
						title: 'Switched to Time Limits',
						message:
							'Max plan quota window has reset - agents on this account are back on Time Limits.',
					});
				}

				// The mode resolver may have re-sampled usage as part of its
				// decision - pull the latest snapshot map so the popover bars
				// reflect the same numbers the spawner just acted on.
				void useClaudeUsageStore.getState().refresh();
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, [ownedGate]);
}
