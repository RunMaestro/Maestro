/**
 * useWorktreeRunTarget Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage which worktree (if any) a
 * run should dispatch to: the selected target, the parent/child session
 * lookup for the WorktreeRunSection UI, and opening the worktree config
 * overlay. Complements useWorktreeValidation, which validates a path rather
 * than choosing a target.
 */

import { useState, useMemo, useCallback } from 'react';
import type { Session, WorktreeRunTarget } from '../../types';
import { getModalActions } from '../../stores/modalStore';

export interface UseWorktreeRunTargetDeps {
	activeSession: Session | undefined;
	sessions: Session[];
	sessionId: string;
}

export interface UseWorktreeRunTargetReturn {
	worktreeTarget: WorktreeRunTarget | null;
	setWorktreeTarget: React.Dispatch<React.SetStateAction<WorktreeRunTarget | null>>;
	isPreparingWorktree: boolean;
	setIsPreparingWorktree: React.Dispatch<React.SetStateAction<boolean>>;
	worktreeParentSession: Session | null;
	worktreeChildren: Session[];
	handleOpenWorktreeConfig: () => void;
}

export function useWorktreeRunTarget({
	activeSession,
	sessions,
	sessionId,
}: UseWorktreeRunTargetDeps): UseWorktreeRunTargetReturn {
	const [worktreeTarget, setWorktreeTarget] = useState<WorktreeRunTarget | null>(null);
	const [isPreparingWorktree, setIsPreparingWorktree] = useState(false);

	// When the current session is a worktree child, worktree config lives on its parent.
	// Resolve the parent so the WorktreeRunSection can read basePath and list siblings.
	const worktreeParentSession = useMemo(() => {
		if (!activeSession) return null;
		if (activeSession.parentSessionId) {
			return sessions.find((s) => s.id === activeSession.parentSessionId) ?? activeSession;
		}
		return activeSession;
	}, [activeSession, sessions]);
	const worktreeChildren = useMemo(
		() =>
			worktreeParentSession
				? sessions.filter(
						(s) => s.parentSessionId === worktreeParentSession.id && s.id !== sessionId
					)
				: [],
		[sessions, worktreeParentSession, sessionId]
	);

	const handleOpenWorktreeConfig = useCallback(() => {
		// Open worktree config on top of the batch runner (WORKTREE_CONFIG priority 752 > BATCH_RUNNER 720).
		// The batch runner stays open underneath so the user returns to it after configuring.
		getModalActions().setWorktreeConfigModalOpen(true);
	}, []);

	return {
		worktreeTarget,
		setWorktreeTarget,
		isPreparingWorktree,
		setIsPreparingWorktree,
		worktreeParentSession,
		worktreeChildren,
		handleOpenWorktreeConfig,
	};
}
