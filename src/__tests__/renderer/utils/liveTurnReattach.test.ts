/**
 * Tests for liveTurnReattach - re-deriving busy state from the main process's
 * live turn table after a web-desktop page reload (issue #1464).
 */

import { describe, it, expect } from 'vitest';
import { resolveLiveAiTurns, applyLiveAiTurns } from '../../../renderer/utils/liveTurnReattach';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

const proc = (overrides: Partial<Parameters<typeof resolveLiveAiTurns>[0][number]>) => ({
	sessionId: 'agent-1-ai-tab-1',
	pid: 100,
	isTerminal: false,
	startTime: 1000,
	...overrides,
});

describe('resolveLiveAiTurns', () => {
	it('resolves an AI tab process into its agent and tab', () => {
		expect(resolveLiveAiTurns([proc({})])).toEqual([
			{ sessionId: 'agent-1', tabId: 'tab-1', pid: 100, startTime: 1000 },
		]);
	});

	it('resolves a forced-parallel turn onto its originating tab', () => {
		expect(resolveLiveAiTurns([proc({ sessionId: 'agent-1-ai-tab-1-fp-2' })])[0]).toMatchObject({
			sessionId: 'agent-1',
			tabId: 'tab-1',
		});
	});

	it('skips terminals, Cue runs, and non-AI-tab ids', () => {
		const resolved = resolveLiveAiTurns([
			proc({ sessionId: 'agent-1-terminal', isTerminal: true }),
			proc({ sessionId: 'agent-1-ai-tab-9', isCueRun: true }),
			proc({ sessionId: 'agent-1-batch-1700000000' }),
			proc({ sessionId: 'agent-1' }),
		]);
		expect(resolved).toEqual([]);
	});
});

describe('applyLiveAiTurns', () => {
	const idleSession = (id = 'agent-1') =>
		createMockSession({
			id,
			state: 'idle',
			aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
		});

	it('marks the agent and the running tab busy', () => {
		const [session] = applyLiveAiTurns(
			[idleSession()],
			[{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 }]
		);

		expect(session.state).toBe('busy');
		expect(session.busySource).toBe('ai');
		expect(session.thinkingStartTime).toBe(1000);
		expect(session.aiPid).toBe(42);
		expect(session.aiTabs[0]).toMatchObject({ state: 'busy', thinkingStartTime: 1000 });
		// A tab with no live turn stays idle.
		expect(session.aiTabs[1].state).toBe('idle');
	});

	it('uses the earliest start time when an agent has several live turns', () => {
		const [session] = applyLiveAiTurns(
			[idleSession()],
			[
				{ sessionId: 'agent-1', tabId: 'tab-2', pid: 43, startTime: 5000 },
				{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 },
			]
		);

		expect(session.thinkingStartTime).toBe(1000);
		expect(session.aiTabs[0].thinkingStartTime).toBe(1000);
		expect(session.aiTabs[1].thinkingStartTime).toBe(5000);
	});

	it('marks the agent busy even when its tab is gone', () => {
		const [session] = applyLiveAiTurns(
			[createMockSession({ id: 'agent-1', state: 'idle', aiTabs: [] })],
			[{ sessionId: 'agent-1', tabId: 'closed-tab', pid: 42, startTime: 1000 }]
		);

		expect(session.state).toBe('busy');
	});

	it('leaves agents with no live turn untouched', () => {
		const sessions = [idleSession('agent-1'), idleSession('agent-2')];
		const next = applyLiveAiTurns(sessions, [
			{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 },
		]);

		expect(next[1]).toBe(sessions[1]);
		expect(next[1].state).toBe('idle');
	});

	it('returns the same array when there is nothing running', () => {
		const sessions = [idleSession()];
		expect(applyLiveAiTurns(sessions, [])).toBe(sessions);
	});

	it('does not overwrite a restored limit pause', () => {
		const paused = createMockSession({
			id: 'agent-1',
			state: 'error',
			agentErrorPaused: true,
			aiTabs: [createMockAITab({ id: 'tab-1' })],
		});
		const [session] = applyLiveAiTurns(
			[paused],
			[{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42, startTime: 1000 }]
		);

		expect(session.state).toBe('error');
		expect(session.agentErrorPaused).toBe(true);
	});

	it('falls back to now when main reports no start time', () => {
		const [session] = applyLiveAiTurns(
			[idleSession()],
			[{ sessionId: 'agent-1', tabId: 'tab-1', pid: 42 }],
			7777
		);

		expect(session.thinkingStartTime).toBe(7777);
		expect(session.aiTabs[0].thinkingStartTime).toBe(7777);
	});
});
