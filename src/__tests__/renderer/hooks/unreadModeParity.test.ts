/**
 * Parity round 3, N6: a tab that receives the agent's answer while the person is not watching it
 * turns unread in every mode. A local and an SSH tab decide when the answer reaches it as data
 * (`useAgentDataListener` -> `markUnread()`, at the provider's result); a hosted tab's answer
 * arrives with the host sync once the host recorded it (`projectHostedSession()`), which applies
 * the same rule. Partial text streams as thinking locally and as live entries from the host, and
 * marks nothing in either.
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentDataListener } from '../../../renderer/hooks/agent/internal/useAgentDataListener';
import type { BatchedUpdater } from '../../../renderer/hooks/agent/internal/types';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import type { LiveTurn } from '../../../shared/maestro-lib/client/live-turn';
import { liveTurnKey } from '../../../shared/maestro-lib/client/live-turn';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

/** Where the person is when the answer streams into tab `t1`. */
interface Viewing {
	agentShown: boolean;
	tabShown: boolean;
	atBottom: boolean;
}

function seed(mode: AgentMode, viewing: Viewing) {
	const session = createModeSession(mode, {
		id: `row-${mode}`,
		activeTabId: viewing.tabShown ? 't1' : 't2',
		aiTabs: [
			createMockAITab({ id: 't1', state: 'busy', isAtBottom: viewing.atBottom, logs: [] }),
			createMockAITab({ id: 't2', logs: [] }),
		],
	});
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: viewing.agentShown ? session.id : 'another-agent',
	} as never);
	return session;
}

let onData: ((sessionId: string, data: string) => void) | undefined;

/** `streaming`: partial text arrives. `answered`: the provider reported its result. */
type Moment = 'streaming' | 'answered';
const ANSWER = 'The login form now checks the token.';

/** A local or SSH tab: partial text streams as thinking (no data event); the result is data. */
function localUnread(mode: AgentMode, viewing: Viewing, moment: Moment): boolean | undefined {
	const session = seed(mode, viewing);
	const markUnread = vi.fn();
	const batched = {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread,
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	} as unknown as BatchedUpdater;
	const { unmount } = renderHook(() =>
		useAgentDataListener({ batchedUpdater: batched, activeHiddenToolRef: { current: new Map() } })
	);
	if (moment === 'answered') onData!(`${session.id}-ai-t1`, ANSWER);
	unmount();
	return markUnread.mock.calls.at(-1)?.[2];
}

/** A hosted tab watched running; then the host records its answer (or streams a partial). */
function hostedUnread(viewing: Viewing, moment: Moment): boolean | undefined {
	const session = seed('hosted', viewing);
	const key = liveTurnKey('h1', 't1');
	const user = { id: 'u1', timestamp: 1, source: 'user' as const, text: 'Fix the login bug' };
	const projected = projectHostedSession(session, {
		agent: {
			id: 'h1',
			name: 'Docs',
			toolType: 'claude-code',
			aiTabs: [
				{ id: 't1', state: moment === 'answered' ? 'idle' : 'busy' },
				{ id: 't2', state: 'idle' },
			],
		},
		transcripts: {
			[key]: {
				loaded: true,
				entries:
					moment === 'answered'
						? [user, { id: 'a1', timestamp: 3, source: 'stdout', text: ANSWER }]
						: [user],
			},
		},
		...(moment === 'streaming'
			? {
					liveTurns: {
						[key]: {
							entries: [{ id: 'p1', timestamp: 2, source: 'stdout', text: 'Looking at' }],
							startedAt: 1,
						} as unknown as LiveTurn,
					},
				}
			: {}),
		viewing: useSessionStore.getState().activeSessionId === session.id,
	});
	return projected.aiTabs.find((tab) => tab.id === 't1')?.hasUnread;
}

beforeEach(() => {
	onData = undefined;
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...(window as unknown as { maestro: Record<string, unknown> }).maestro,
		process: {
			onData: vi.fn((handler: typeof onData) => {
				onData = handler;
				return () => {};
			}),
		},
		agentError: { clearError: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('unread when the answer arrives, in every mode', () => {
	it.each<[string, Viewing, boolean]>([
		['watched at the bottom', { agentShown: true, tabShown: true, atBottom: true }, false],
		['watched but scrolled up', { agentShown: true, tabShown: true, atBottom: false }, true],
		['another tab shown', { agentShown: true, tabShown: false, atBottom: true }, true],
		['another agent shown', { agentShown: false, tabShown: true, atBottom: true }, true],
	])('%s: local, SSH, and hosted tabs agree', (_label, viewing, expected) => {
		const outcomes = AGENT_MODES.map((mode) =>
			mode === 'hosted' ? hostedUnread(viewing, 'answered') : localUnread(mode, viewing, 'answered')
		);
		expect(outcomes).toEqual([expected, expected, expected]);
	});

	it('streamed partial text changes no tab, in any mode', () => {
		const viewing = { agentShown: false, tabShown: false, atBottom: true };
		const outcomes = AGENT_MODES.map((mode) =>
			mode === 'hosted'
				? hostedUnread(viewing, 'streaming')
				: localUnread(mode, viewing, 'streaming')
		);
		expect(outcomes).toEqual([undefined, undefined, undefined]);
	});
});
