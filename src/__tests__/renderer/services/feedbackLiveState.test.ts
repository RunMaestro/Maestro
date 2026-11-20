import { afterEach, describe, expect, it } from 'vitest';
import { createMockSession } from '../../helpers/mockSession';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useAutoRunResumeStore } from '../../../renderer/stores/autoRunResumeStore';
import {
	captureFeedbackLiveState,
	installFeedbackLiveStateHook,
} from '../../../renderer/services/feedbackLiveState';
import { FEEDBACK_LIVE_STATE_GLOBAL } from '../../../shared/feedbackLiveState';
import { createMockAITab } from '../../helpers/mockTab';

describe('captureFeedbackLiveState', () => {
	it('separates agent identity, selected tab provider and captured failure ownership', () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: 'mixed',
					state: 'error',
					agentErrorTabId: 'tab-1',
					agentError: {
						type: 'auth_expired',
						agentId: 'codex',
						recoverable: true,
						timestamp: 10,
						message: 'expired',
					},
					aiTabs: [
						createMockAITab({ id: 'tab-1', tabProvider: 'claude-code', turnProvider: 'codex' }),
					],
					orphanedThinkingTabs: [
						createMockAITab({
							id: 'closed',
							tabProvider: 'codex',
							turnProvider: 'claude-code',
							state: 'busy',
						}),
					],
				}),
			],
		});
		const [agent] = captureFeedbackLiveState(100).agents;
		expect(agent.provider).toBe('claude-code');
		expect(agent.error?.provider).toBe('codex');
		expect(agent.tabs).toEqual([
			{ id: 'tab-1', provider: 'claude-code', turnProvider: 'codex', state: 'idle' },
			{ id: 'closed', provider: 'codex', turnProvider: 'claude-code', state: 'busy' },
		]);
	});

	afterEach(() => {
		useSessionStore.setState({ sessions: [] });
		useAutoRunResumeStore.setState({ entries: {} });
	});

	it('details only notable agents and counts the rest', () => {
		const now = 1_000_000;
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'idle', name: 'Quiet', state: 'idle' }),
				createMockSession({
					id: 'limited',
					name: 'Busy Bee',
					state: 'error',
					agentErrorPaused: true,
					agentError: {
						type: 'rate_limited',
						message: 'usage limit reached',
						recoverable: true,
						agentId: 'claude-code',
						timestamp: now - 60_000,
						limitResetAt: now - 1_000,
					},
				}),
			],
		});
		useAutoRunResumeStore.setState({
			entries: {
				limited: {
					sessionId: 'limited',
					attempts: 2,
					maxAttempts: 5,
					nextResumeAt: now + 30_000,
					exhausted: false,
					lastMessage: 'x',
				},
			},
		});

		const state = captureFeedbackLiveState(now);
		expect(state.agentCount).toBe(2);
		expect(state.agents.map((a) => a.id)).toEqual(['limited']);
		const [agent] = state.agents;
		expect(agent.error).toMatchObject({
			type: 'rate_limited',
			limit: true,
			paused: true,
			ageMs: 60_000,
			limitResetInMs: -1_000,
		});
		expect(agent.autoResume).toEqual({
			attempts: 2,
			maxAttempts: 5,
			nextResumeInMs: 30_000,
			exhausted: false,
		});
	});

	it('installs and removes the global main evaluates', () => {
		const uninstall = installFeedbackLiveStateHook();
		const target = window as unknown as Record<string, unknown>;
		expect(typeof target[FEEDBACK_LIVE_STATE_GLOBAL]).toBe('function');
		uninstall();
		expect(target[FEEDBACK_LIVE_STATE_GLOBAL]).toBeUndefined();
	});
});
