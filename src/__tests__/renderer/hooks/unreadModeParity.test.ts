/**
 * Parity round 3, N6: a tab that receives the agent's answer while the person is not watching it
 * turns unread in every mode. A local and an SSH tab decide on each output chunk
 * (`useAgentDataListener` -> `markUnread()`); a hosted tab's output arrives with the host sync
 * (`projectHostedSession()`), which applies the same rule.
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

function localUnread(mode: AgentMode, viewing: Viewing): boolean | undefined {
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
	onData!(`${session.id}-ai-t1`, 'Looking at the login form.');
	unmount();
	return markUnread.mock.calls.at(-1)?.[2];
}

function hostedUnread(viewing: Viewing): boolean | undefined {
	const session = seed('hosted', viewing);
	const live = {
		entries: [{ id: 'a1', timestamp: 2, source: 'stdout', text: 'Looking at the login form.' }],
		startedAt: 1,
	} as unknown as LiveTurn;
	const projected = projectHostedSession(session, {
		agent: {
			id: 'h1',
			name: 'Docs',
			toolType: 'claude-code',
			aiTabs: [
				{ id: 't1', state: 'busy' },
				{ id: 't2', state: 'idle' },
			],
		},
		liveTurns: { [liveTurnKey('h1', 't1')]: live },
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

describe('unread on streamed output, in every mode', () => {
	it.each<[string, Viewing, boolean]>([
		['watched at the bottom', { agentShown: true, tabShown: true, atBottom: true }, false],
		['watched but scrolled up', { agentShown: true, tabShown: true, atBottom: false }, true],
		['another tab shown', { agentShown: true, tabShown: false, atBottom: true }, true],
		['another agent shown', { agentShown: false, tabShown: true, atBottom: true }, true],
	])('%s: local, SSH, and hosted tabs agree', (_label, viewing, expected) => {
		const outcomes = AGENT_MODES.map((mode) =>
			mode === 'hosted' ? hostedUnread(viewing) : localUnread(mode, viewing)
		);
		expect(outcomes).toEqual([expected, expected, expected]);
	});
});
