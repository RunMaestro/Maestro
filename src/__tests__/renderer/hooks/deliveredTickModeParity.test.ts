/**
 * Parity round 3, N3: the "Message delivered" tick on the user's bubble appears at the same moment
 * in every mode. A local and an SSH tab mark the message delivered when the agent's first output
 * for it arrives (`markDelivered()` on a data chunk, `useBatchedSessionUpdates`); a hosted tab
 * draws the host's transcript (`projectHostedSession()`), whose user entry the host records as
 * delivered when the turn starts, so the projection applies the same rule.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useBatchedSessionUpdates } from '../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { LogEntry, Session } from '../../../renderer/types';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import type { LiveTurn } from '../../../shared/maestro-lib/client/live-turn';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const TAB = 't1';
const USER: LogEntry = { id: 'u1', timestamp: 1, source: 'user', text: 'Fix the login bug' };

type Moment = 'sent' | 'answering' | 'failed';

function tickOf(logs: readonly LogEntry[]): boolean {
	return !!logs.find((entry) => entry.source === 'user')?.delivered;
}

/** A local or SSH tab: the message is in the tab, then the agent's output (or none) arrives. */
function localTick(mode: AgentMode, moment: Moment): boolean {
	const session = createModeSession(mode, {
		id: `row-${mode}`,
		activeTabId: TAB,
		aiTabs: [createMockAITab({ id: TAB, state: 'busy', logs: [USER] })],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	const { result, unmount } = renderHook(() => useBatchedSessionUpdates());
	act(() => {
		if (moment === 'answering') {
			result.current.appendLog(session.id, TAB, true, 'Looking at the login form.');
			result.current.markDelivered(session.id, TAB);
		}
		if (moment === 'failed') {
			result.current.appendLog(session.id, TAB, false, 'The agent exited with code 1.');
		}
		result.current.flushNow();
	});
	unmount();
	const tab = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === TAB);
	return tickOf(tab?.logs ?? []);
}

/** A hosted tab: the host's record of the same moment, folded into the record. */
function hostedTick(moment: Moment): boolean {
	const userRecord: LogEntryRecord = { ...USER, delivered: true };
	const agent: AgentRecord = {
		id: 'h1',
		name: 'Docs',
		toolType: 'claude-code',
		activeTabId: TAB,
		aiTabs: [{ id: TAB, state: moment === 'failed' ? 'idle' : 'busy' }],
	};
	const persisted: LogEntryRecord[] =
		moment === 'failed'
			? [
					userRecord,
					{ id: 'e1', timestamp: 3, source: 'error', text: 'The agent exited with code 1.' },
				]
			: [userRecord];
	const live: LiveTurn | undefined =
		moment === 'answering'
			? ({
					entries: [
						{ id: 'a1', timestamp: 2, source: 'stdout', text: 'Looking at the login form.' },
					],
					startedAt: 1,
				} as unknown as LiveTurn)
			: undefined;
	const session: Session = createModeSession('hosted', {
		id: 'row-hosted',
		activeTabId: TAB,
		aiTabs: [createMockAITab({ id: TAB, logs: [] })],
	});
	const key = liveTurnKey('h1', TAB);
	const projected = projectHostedSession(session, {
		agent,
		transcripts: { [key]: { entries: persisted, loaded: true } },
		...(live ? { liveTurns: { [key]: live } } : {}),
	});
	return tickOf(projected.aiTabs.find((t) => t.id === TAB)?.logs ?? []);
}

describe('"Message delivered" tick in every mode', () => {
	it.each<[Moment, boolean]>([
		['sent', false],
		['answering', true],
		['failed', false],
	])('%s: local, SSH, and hosted bubbles show delivered=%s', (moment, expected) => {
		const ticks = AGENT_MODES.map((mode) =>
			mode === 'hosted' ? hostedTick(moment) : localTick(mode, moment)
		);
		expect(ticks).toEqual([expected, expected, expected]);
	});
});
