import { useState, useCallback } from 'react';
import { captureException } from '../../../utils/sentry';
import type { Session } from '../../../types';

interface UseAgentSessionsStarArgs {
	activeSession: Session | undefined;
	agentId: string;
	onUpdateTab?: (
		agentSessionId: string,
		updates: { name?: string | null; starred?: boolean }
	) => void;
}

export function useAgentSessionsStar({
	activeSession,
	agentId,
	onUpdateTab,
}: UseAgentSessionsStarArgs): {
	starredSessions: Set<string>;
	setStarredSessions: React.Dispatch<React.SetStateAction<Set<string>>>;
	toggleStar: (sessionId: string, e: React.MouseEvent) => Promise<void>;
} {
	const [starredSessions, setStarredSessions] = useState<Set<string>>(new Set());

	const toggleStar = useCallback(
		async (sessionId: string, e: React.MouseEvent) => {
			e.stopPropagation();

			// Compute desired state from the current closure value (synchronous),
			// then use functional updater so rapid multi-session toggles compose correctly.
			const isNowStarred = !starredSessions.has(sessionId);
			setStarredSessions((prev) => {
				const updated = new Set(prev);
				if (isNowStarred) {
					updated.add(sessionId);
				} else {
					updated.delete(sessionId);
				}
				return updated;
			});

			if (activeSession?.projectRoot) {
				try {
					if (agentId === 'claude-code') {
						await window.maestro.claude.updateSessionStarred(
							activeSession.projectRoot,
							sessionId,
							isNowStarred
						);
					} else {
						await window.maestro.agentSessions.setSessionStarred(
							agentId,
							activeSession.projectRoot,
							sessionId,
							isNowStarred
						);
					}
				} catch (error) {
					// Revert optimistic update on IPC failure
					setStarredSessions((prev) => {
						const reverted = new Set(prev);
						if (isNowStarred) {
							reverted.delete(sessionId);
						} else {
							reverted.add(sessionId);
						}
						return reverted;
					});
					captureException(error, {
						extra: { fn: 'useAgentSessionsStar', agentId, sessionId },
					});
					return;
				}
			}

			onUpdateTab?.(sessionId, { starred: isNowStarred });
		},
		[starredSessions, activeSession?.projectRoot, agentId, onUpdateTab]
	);

	return { starredSessions, setStarredSessions, toggleStar };
}
