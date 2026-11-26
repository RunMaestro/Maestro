/**
 * Parity round 3, N3: the "Message delivered" tick on the user's bubble appears at the same moment
 * in every mode. A local and an SSH tab mark the message delivered when the agent's answer reaches
 * the tab as data (`useAgentDataListener` -> `markDelivered()` in `useBatchedSessionUpdates`); the
 * main process emits that data when the provider reports its result, while partial text streams
 * as thinking and marks nothing. A hosted tab draws the host's transcript
 * (`projectHostedSession()`): the host records the user entry as delivered when its turn starts
 * and streams partial text as live entries, so the projection waits for the answer it recorded.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentDataListener } from '../../../renderer/hooks/agent/internal/useAgentDataListener';
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
const ANSWER = 'The login form now checks the token.';

/**
 * `sent`: the turn runs, nothing came back. `streaming`: partial text is arriving. `answered`: the
 * provider reported its result. `failed`: the turn ended on an error with no answer.
 */
type Moment = 'sent' | 'streaming' | 'answered' | 'failed';

let onData: ((sessionId: string, data: string) => void) | undefined;

beforeEach(() => {
	onData = undefined;
	const maestro = (window as unknown as { maestro: Record<string, unknown> }).maestro;
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...maestro,
		process: {
			...(maestro.process as Record<string, unknown>),
			onData: vi.fn((handler: typeof onData) => {
				onData = handler;
				return () => {};
			}),
		},
		agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
	};
});

function tickOf(logs: readonly LogEntry[]): boolean {
	return !!logs.find((entry) => entry.source === 'user')?.delivered;
}

/** A local or SSH tab, driven through the data event route its process uses. */
function localTick(mode: AgentMode, moment: Moment): boolean {
	const session = createModeSession(mode, {
		id: `row-${mode}`,
		activeTabId: TAB,
		aiTabs: [createMockAITab({ id: TAB, state: 'busy', logs: [USER] })],
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	const batched = renderHook(() => useBatchedSessionUpdates());
	const listener = renderHook(() =>
		useAgentDataListener({
			batchedUpdater: batched.result.current,
			activeHiddenToolRef: { current: new Map() },
		})
	);
	act(() => {
		// Partial text streams as thinking (no data event); only the result is data.
		if (moment === 'answered') onData!(`${session.id}-ai-${TAB}`, ANSWER);
		if (moment === 'failed') {
			batched.result.current.appendLog(session.id, TAB, false, 'The agent exited with code 1.');
		}
		batched.result.current.flushNow();
	});
	listener.unmount();
	batched.unmount();
	const tab = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === TAB);
	return tickOf(tab?.logs ?? []);
}

/** A hosted tab: the host's record of the same moment, folded into the record. */
function hostedTick(moment: Moment): boolean {
	const userRecord: LogEntryRecord = { ...USER, delivered: true };
	const ended = moment === 'answered' || moment === 'failed';
	const agent: AgentRecord = {
		id: 'h1',
		name: 'Docs',
		toolType: 'claude-code',
		activeTabId: TAB,
		aiTabs: [{ id: TAB, state: ended ? 'idle' : 'busy' }],
	};
	const persisted: LogEntryRecord[] = [userRecord];
	if (moment === 'answered') {
		persisted.push({ id: 'a1', timestamp: 3, source: 'stdout', text: ANSWER });
	}
	if (moment === 'failed') {
		persisted.push({
			id: 'e1',
			timestamp: 3,
			source: 'error',
			text: 'The agent exited with code 1.',
		});
	}
	const live: LiveTurn | undefined =
		moment === 'streaming'
			? ({
					entries: [{ id: 'p1', timestamp: 2, source: 'stdout', text: 'Looking at the' }],
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
		['streaming', false],
		['answered', true],
		['failed', false],
	])('%s: local, SSH, and hosted bubbles show delivered=%s', (moment, expected) => {
		const ticks = AGENT_MODES.map((mode) =>
			mode === 'hosted' ? hostedTick(moment) : localTick(mode, moment)
		);
		expect(ticks).toEqual([expected, expected, expected]);
	});
});
