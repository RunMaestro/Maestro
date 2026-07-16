import { describe, expect, it } from 'vitest';
import { classifyProcessExit } from '../../../renderer/hooks/agent/internal/agentExecutionErrorPolicy';
import { reduceAgentQueueAfterExit } from '../../../renderer/hooks/agent/internal/agentExecutionQueueReducer';
import {
	createBatchAgentSpawnConfig,
	createSynopsisAgentSpawnConfig,
} from '../../../renderer/hooks/agent/internal/agentExecutionSpawnAdapter';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

describe('agent execution error policy', () => {
	it.each([
		[0, { success: true }],
		[1, { success: false, error: 'Agent task exited with code 1', errorKind: 'process-exit' }],
		[
			null,
			{
				success: false,
				error: 'Agent task exited without a status code',
				errorKind: 'process-exit-unknown',
			},
		],
		[
			undefined,
			{
				success: false,
				error: 'Agent task exited without a status code',
				errorKind: 'process-exit-unknown',
			},
		],
	])('classifies process exit %s exactly', (code, expected) => {
		expect(classifyProcessExit(code)).toEqual(expected);
	});
});

describe('agent execution queue reducer', () => {
	it('dequeues the first runnable item without reordering held or later work', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy', logs: [] });
		const held = {
			id: 'held',
			timestamp: 1,
			tabId: tab.id,
			type: 'message' as const,
			text: 'held',
			paused: true,
		};
		const next = {
			id: 'next',
			timestamp: 2,
			tabId: tab.id,
			type: 'message' as const,
			text: 'next',
		};
		const later = {
			id: 'later',
			timestamp: 3,
			tabId: tab.id,
			type: 'message' as const,
			text: 'later',
		};
		const session = createMockSession({
			state: 'busy',
			aiTabs: [tab],
			activeTabId: tab.id,
			executionQueue: [held, next, later],
		});

		const transition = reduceAgentQueueAfterExit(session, 1234, () => 'log-1');

		expect(transition.dequeuedItem).toBe(next);
		expect(transition.session.executionQueue.map((item) => item.id)).toEqual(['held', 'later']);
		expect(transition.session.state).toBe('busy');
		expect(transition.session.aiTabs[0].logs).toEqual([
			{ id: 'log-1', timestamp: 1234, source: 'user', text: 'next', images: undefined },
		]);
	});

	it('leaves held work in place and transitions all busy tabs to idle when no work is runnable', () => {
		const tab = createMockAITab({ id: 'tab-1', state: 'busy' });
		const held = {
			id: 'held',
			timestamp: 1,
			tabId: tab.id,
			type: 'message' as const,
			text: 'held',
			paused: true,
		};
		const session = createMockSession({ state: 'busy', aiTabs: [tab], executionQueue: [held] });

		const transition = reduceAgentQueueAfterExit(session, 1234, () => 'unused');

		expect(transition.dequeuedItem).toBeNull();
		expect(transition.session.executionQueue).toEqual([held]);
		expect(transition.session.state).toBe('idle');
		expect(transition.session.aiTabs[0]).toMatchObject({
			state: 'idle',
			thinkingStartTime: undefined,
		});
	});

	it('keeps the session busy and removes one runnable item when no tab target remains', () => {
		const item = { id: 'next', timestamp: 2, type: 'command' as const, command: '/status' };
		const session = createMockSession({ state: 'busy', aiTabs: [], executionQueue: [item] });

		const transition = reduceAgentQueueAfterExit(session, 1234, () => 'unused');

		expect(transition.dequeuedItem).toBe(item);
		expect(transition.session).toMatchObject({
			state: 'busy',
			busySource: 'ai',
			executionQueue: [],
		});
	});
});

describe('agent execution spawn adapter', () => {
	it('preserves batch and synopsis spawn contracts', () => {
		const session = createMockSession({
			customPath: 'custom-agent',
			customArgs: '--verbose',
			customEnvVars: { TOKEN: 'test' },
			customModel: 'model-x',
			customEffort: 'high',
			customContextWindow: 100000,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		const agent = {
			id: 'claude-code',
			name: 'Claude',
			available: true,
			command: 'claude',
			args: ['--print'],
		};

		expect(
			createBatchAgentSpawnConfig({
				targetSessionId: 'batch-1',
				session,
				command: 'claude',
				agent,
				cwd: '/worktree',
				prompt: 'Do work',
				appendSystemPrompt: 'System',
				sendPromptViaStdin: false,
				sendPromptViaStdinRaw: true,
			})
		).toMatchObject({
			sessionId: 'batch-1',
			toolType: 'claude-code',
			cwd: '/worktree',
			command: 'claude',
			args: ['--print'],
			prompt: 'Do work',
			appendSystemPrompt: 'System',
			readOnlyMode: false,
			permissionMode: 'full',
			sessionCustomEffort: 'high',
			sendPromptViaStdinRaw: true,
		});

		expect(
			createSynopsisAgentSpawnConfig({
				targetSessionId: 'synopsis-1',
				toolType: 'claude-code',
				cwd: '/repo',
				command: 'claude',
				args: ['--print'],
				prompt: 'Summarize',
				agentSessionId: 'resume-1',
				sessionConfig: {
					customPath: 'custom-agent',
					enableMaestroP: true,
					maestroPMode: 'dynamic',
				},
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				sendPromptViaStdin: false,
				sendPromptViaStdinRaw: false,
			})
		).toMatchObject({
			sessionId: 'synopsis-1',
			agentSessionId: 'resume-1',
			sessionCustomPath: 'custom-agent',
			enableMaestroP: true,
			maestroPMode: 'dynamic',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
	});
});
