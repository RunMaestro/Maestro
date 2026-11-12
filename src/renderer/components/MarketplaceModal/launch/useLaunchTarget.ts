/**
 * useLaunchTarget - the launch dialog's "Run on" choice.
 *
 * The dialog never edits an agent, so the choice is only a pointer: the agent this window has
 * selected (`current`), another stored agent (`existing`), or the draft the New Agent modal
 * captured (`new`, which creates nothing until Launch). The hook turns the pointer into the
 * `LaunchTarget` the submit path takes (`launchPlaybook()` in `services/playbookLaunch.ts`), the
 * summary the read-only card shows, and the reason the choice cannot launch yet, if it cannot.
 */

import { useCallback, useMemo, useState } from 'react';
import { useActiveSession } from '../../../hooks/session/useActiveSession';
import { useLiveSessions } from '../../../hooks/session/useLiveSessions';
import type { LaunchTarget } from '../../../services/playbookLaunch';
import type { Session } from '../../../types';
import type { NewAgentDraft } from '../../NewInstanceModal/types';
import {
	launchableSessions,
	summarizeLaunchDraft,
	summarizeLaunchSession,
	type LaunchAgentSummary,
} from './launchAgents';

export type LaunchRunOn = 'current' | 'existing' | 'new';

/** Why a choice that names no agent yet cannot launch. */
const NO_AGENT_PROBLEM: Record<LaunchRunOn, string> = {
	current: 'No agent is selected. Select one, then launch again.',
	existing: 'Choose the agent to launch on.',
	new: 'Set up the new agent to launch on.',
};

export interface LaunchTargetChoice {
	runOn: LaunchRunOn;
	setRunOn: (runOn: LaunchRunOn) => void;
	/** The agents "Existing agent" offers: those with an Auto Run folder. */
	existingSessions: Session[];
	/** The pick under "Existing agent"; `''` before one is made. */
	existingSessionId: string;
	setExistingSessionId: (sessionId: string) => void;
	/** What the New Agent modal captured, or `null` before the first capture. */
	draft: NewAgentDraft | null;
	setDraft: (draft: NewAgentDraft | null) => void;
	/** The agent this window has selected: what "Current agent" means. */
	currentSession: Session | null;
	/** What the launch runs on; `null` while the choice names no agent yet. */
	target: LaunchTarget | null;
	/** The chosen agent, for the read-only card; `null` while none is chosen. */
	summary: LaunchAgentSummary | null;
	/** Why the choice cannot launch: no agent chosen yet, or the chosen one cannot be launched on. */
	problem: string | undefined;
	/** The chosen agent works on an SSH remote. */
	remote: boolean;
	/**
	 * Point the choice at an agent that now exists and drop the draft. For a launch that created
	 * its agent and then failed: the retry runs on that agent instead of creating a second one.
	 */
	switchToExistingAgent: (sessionId: string) => void;
}

export function useLaunchTarget(): LaunchTargetChoice {
	const sessions = useLiveSessions();
	const currentSession = useActiveSession();
	const [runOn, setRunOn] = useState<LaunchRunOn>('current');
	const [existingSessionId, setExistingSessionId] = useState('');
	const [draft, setDraft] = useState<NewAgentDraft | null>(null);

	const existingSessions = useMemo(() => launchableSessions(sessions), [sessions]);
	const existingSession = useMemo(
		() => sessions.find((session) => session.id === existingSessionId) ?? null,
		[sessions, existingSessionId]
	);

	const target = useMemo<LaunchTarget | null>(() => {
		switch (runOn) {
			case 'current':
				return currentSession ? { kind: 'current' } : null;
			case 'existing':
				return existingSession ? { kind: 'existing', sessionId: existingSession.id } : null;
			case 'new':
				return draft ? { kind: 'new', draft } : null;
		}
	}, [runOn, currentSession, existingSession, draft]);

	const summary = useMemo<LaunchAgentSummary | null>(() => {
		switch (runOn) {
			case 'current':
				return currentSession ? summarizeLaunchSession(currentSession) : null;
			case 'existing':
				return existingSession ? summarizeLaunchSession(existingSession) : null;
			case 'new':
				return draft ? summarizeLaunchDraft(draft) : null;
		}
	}, [runOn, currentSession, existingSession, draft]);

	const switchToExistingAgent = useCallback((sessionId: string) => {
		setRunOn('existing');
		setExistingSessionId(sessionId);
		setDraft(null);
	}, []);

	return {
		runOn,
		setRunOn,
		existingSessions,
		existingSessionId,
		setExistingSessionId,
		draft,
		setDraft,
		currentSession,
		target,
		summary,
		problem: summary ? summary.problem : NO_AGENT_PROBLEM[runOn],
		remote: summary?.remote ?? false,
		switchToExistingAgent,
	};
}
