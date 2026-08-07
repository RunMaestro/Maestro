/**
 * useGoalDrivenConfig Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage Goal-Driven Auto Run state:
 * the active tab (Spec vs Goal), the goal text, exit criteria, and max
 * iterations, plus debounced persistence back onto the session so the modal
 * reopens with the same inputs.
 */

import { useState, useRef, useEffect } from 'react';
import type { Session } from '../../types';
import { useDebouncedCallback } from '../utils/useThrottle';
import { updateSessionWith } from '../../stores/sessionStore';

export interface UseGoalDrivenConfigDeps {
	sessionId: string;
	activeSession: Session | undefined;
}

export interface UseGoalDrivenConfigReturn {
	autoRunMode: 'spec' | 'goal';
	setAutoRunMode: React.Dispatch<React.SetStateAction<'spec' | 'goal'>>;
	goal: string;
	setGoal: React.Dispatch<React.SetStateAction<string>>;
	exitCriteria: string;
	setExitCriteria: React.Dispatch<React.SetStateAction<string>>;
	maxIterations: number | null;
	setMaxIterations: React.Dispatch<React.SetStateAction<number | null>>;
	/** Flush a pending debounced save immediately (e.g. before close/launch). */
	flushGoalConfig: () => void;
}

export function useGoalDrivenConfig({
	sessionId,
	activeSession,
}: UseGoalDrivenConfigDeps): UseGoalDrivenConfigReturn {
	// Seeded once from the session's persisted goal config (see
	// Session.autoRunDriveMode / autoRunGoalConfig) so reopening the modal
	// restores the tab and the goal inputs. Spec mode is the default.
	const [autoRunMode, setAutoRunMode] = useState<'spec' | 'goal'>(
		() => activeSession?.autoRunDriveMode ?? 'spec'
	);
	const [goal, setGoal] = useState(() => activeSession?.autoRunGoalConfig?.goal ?? '');
	const [exitCriteria, setExitCriteria] = useState(
		() => activeSession?.autoRunGoalConfig?.exitCriteria ?? ''
	);
	const [maxIterations, setMaxIterations] = useState<number | null>(
		() => activeSession?.autoRunGoalConfig?.maxIterations ?? null
	);

	// Persist the goal config + selected Auto Run tab back onto the session so the
	// modal reopens in the same mode with the same inputs. Uses the canonical
	// updateSessionWith helper (NOT a hand-rolled setSessions map). Debounced so
	// typing into the goal/exit fields doesn't thrash the session store.
	const { debouncedCallback: debouncedPersistGoalConfig, flush: flushGoalConfig } =
		useDebouncedCallback(() => {
			updateSessionWith(sessionId, (s) => ({
				...s,
				autoRunDriveMode: autoRunMode,
				autoRunGoalConfig: { goal, exitCriteria, maxIterations },
			}));
		}, 500);

	// Save shortly after the user stops editing or switches tabs. Skip the very
	// first run so seeding from the session doesn't immediately write the same
	// values straight back.
	const didSeedGoalConfigRef = useRef(false);
	useEffect(() => {
		if (!didSeedGoalConfigRef.current) {
			didSeedGoalConfigRef.current = true;
			return;
		}
		debouncedPersistGoalConfig();
	}, [autoRunMode, goal, exitCriteria, maxIterations, debouncedPersistGoalConfig]);

	return {
		autoRunMode,
		setAutoRunMode,
		goal,
		setGoal,
		exitCriteria,
		setExitCriteria,
		maxIterations,
		setMaxIterations,
		flushGoalConfig,
	};
}
