/**
 * Whether an agent is working on a sketch (useSketchAgentWork): a running
 * `@bot` turn, or a sketch tool call made by a turn that is still running.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
	sketchAgentWork,
	sketchAgentWorkLabel,
	useSketchAgentWork,
} from '../../../../renderer/components/SketchBook/useSketchAgentWork';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import {
	useSketchSessionStore,
	type SketchBotRequest,
} from '../../../../renderer/stores/sketchSessionStore';
import type { Session } from '../../../../renderer/types';
import { createMockAITab, createMockSession } from '../../../helpers';

const SKETCH_ID = 'sketch-1';

function agent(overrides: Partial<Session> = {}): Session {
	return createMockSession({ id: 'ada', name: 'Ada', aiTabs: [createMockAITab()], ...overrides });
}

function request(status: SketchBotRequest['status']): SketchBotRequest {
	return {
		replyTo: 'msg-1',
		actor: { id: 'g1', kind: 'guest', name: 'Sam', role: 'rw' },
		text: 'add a box',
		ts: 1,
		status,
		verdict: null,
		posture: 'restricted',
	};
}

const busyTab = (thinkingStartTime: number) =>
	createMockAITab({ id: 'work', state: 'busy', thinkingStartTime });

describe('sketchAgentWork', () => {
	it('is idle with nothing running', () => {
		expect(
			sketchAgentWork({
				sketchId: SKETCH_ID,
				botRequests: [],
				activity: undefined,
				agents: [agent()],
			})
		).toBeNull();
	});

	it('shows a running bot turn, from a guest or the conductor, named for the Sketch tab owner', () => {
		const owner = agent({
			aiTabs: [createMockAITab({ id: 'sketch-tab', sketchOrigin: { sketchId: SKETCH_ID } })],
		});
		expect(
			sketchAgentWork({
				sketchId: SKETCH_ID,
				botRequests: [request('running')],
				activity: undefined,
				agents: [owner],
			})
		).toEqual({ agentName: 'Ada', drawing: false });
	});

	it('does not count a request waiting on approval or a held reply', () => {
		for (const status of ['awaiting_approval', 'held'] as const) {
			expect(
				sketchAgentWork({
					sketchId: SKETCH_ID,
					botRequests: [request(status)],
					activity: undefined,
					agents: [agent()],
				})
			).toBeNull();
		}
	});

	it('shows a tool call while the turn that made it runs, drawing for a canvas write', () => {
		const agents = [agent({ aiTabs: [busyTab(100)] })];
		expect(
			sketchAgentWork({
				sketchId: SKETCH_ID,
				botRequests: undefined,
				activity: { agentId: 'ada', writes: true, at: 150 },
				agents,
			})
		).toEqual({ agentName: 'Ada', drawing: true });
		expect(
			sketchAgentWork({
				sketchId: SKETCH_ID,
				botRequests: undefined,
				activity: { agentId: 'ada', writes: false, at: 150 },
				agents,
			})
		).toEqual({ agentName: 'Ada', drawing: false });
	});

	it('drops a tool call once its turn ends, and a later turn does not bring it back', () => {
		const activity = { agentId: 'ada', writes: true, at: 150 };
		const idle = sketchAgentWork({
			sketchId: SKETCH_ID,
			botRequests: undefined,
			activity,
			agents: [agent()],
		});
		const laterTurn = sketchAgentWork({
			sketchId: SKETCH_ID,
			botRequests: undefined,
			activity,
			agents: [agent({ aiTabs: [busyTab(200)] })],
		});
		expect(idle).toBeNull();
		expect(laterTurn).toBeNull();
	});

	it('counts a busy agent with no busy tab (an Auto Run or Cue process)', () => {
		const batch = agent({ state: 'busy', thinkingStartTime: 100 });
		expect(
			sketchAgentWork({
				sketchId: SKETCH_ID,
				botRequests: undefined,
				activity: { agentId: 'ada', writes: false, at: 150 },
				agents: [batch],
			})
		).toEqual({ agentName: 'Ada', drawing: false });
	});

	it('ignores a call from an agent this window does not hold', () => {
		expect(
			sketchAgentWork({
				sketchId: SKETCH_ID,
				botRequests: undefined,
				activity: { agentId: 'ghost', writes: true, at: 150 },
				agents: [agent({ aiTabs: [busyTab(100)] })],
			})
		).toBeNull();
	});
});

describe('sketchAgentWorkLabel', () => {
	it('names the agent, or falls back when it is not in this window', () => {
		expect(sketchAgentWorkLabel({ agentName: 'Ada', drawing: true })).toBe('Ada is drawing');
		expect(sketchAgentWorkLabel({ agentName: null, drawing: false })).toBe('The agent is working');
	});
});

describe('useSketchAgentWork', () => {
	beforeEach(() => {
		useSketchSessionStore.setState({ sessions: {}, agentActivity: {} });
		useSessionStore.setState({ sessions: [agent({ aiTabs: [busyTab(100)] })] });
	});

	it('lights on a tool call and goes out when the turn ends', () => {
		const { result } = renderHook(() => useSketchAgentWork(SKETCH_ID));
		expect(result.current).toBeNull();

		act(() => {
			useSketchSessionStore
				.getState()
				.noteSketchAgentActivity({ agentId: 'ada', sketchId: SKETCH_ID, writes: true }, 150);
		});
		expect(result.current).toEqual({ agentName: 'Ada', drawing: true });

		act(() => {
			useSessionStore.setState({ sessions: [agent()] });
		});
		expect(result.current).toBeNull();
	});
});
