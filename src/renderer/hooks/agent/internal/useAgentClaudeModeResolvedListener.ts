/**
 * useAgentClaudeModeResolvedListener — registers
 * `window.maestro.process.onClaudeModeResolved`.
 *
 * Mirrors the spawner's headless-mode decision back into the renderer:
 * stamps `session.claudeInteractive.{mode, modeReason, lastUsageSnapshotKey}`
 * so the UI badge, overlay menu, and any auto-resolver state stays in sync
 * with what the process is actually running.
 *
 * Skips the setSessions update when the persisted state already matches —
 * avoids gratuitous re-renders on routine API-mode spawns where nothing
 * changed.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';

export function useAgentClaudeModeResolvedListener(): void {
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;

		const unsubscribe = window.maestro.process.onClaudeModeResolved?.(
			(
				sessionId: string,
				resolution: {
					mode: 'interactive' | 'api';
					reason: 'user' | 'auto' | 'limit';
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
						return {
							...s,
							claudeInteractive: {
								mode: resolution.mode,
								modeReason: resolution.reason,
								lastUsageSnapshotKey: resolution.configDirKey,
							},
						};
					})
				);
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, []);
}
