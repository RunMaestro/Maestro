import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Session, UsageStats } from '../../../renderer/types';
import { useDocumentProcessor } from '../../../renderer/hooks/batch/useDocumentProcessor';

const makeUsage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 10,
	outputTokens: 5,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0.001,
	contextWindow: 1000,
	...overrides,
});

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/repo',
		projectRoot: '/repo',
		state: 'idle',
		busySource: undefined,
		aiTabs: [],
		activeTabId: undefined,
		terminalTabs: [],
		executionQueue: [],
		manualHistory: [],
		historyIndex: -1,
		thinkingStartTime: null,
		isStarred: false,
		isUnread: false,
		hasUnseenOutput: false,
		createdAt: Date.now(),
		customPath: '/usr/local/bin/claude',
		customArgs: '--dangerously-skip-permissions',
		customEnvVars: { FOO: 'bar' },
		customModel: 'claude-sonnet',
		customContextWindow: 200000,
		sessionSshRemoteConfig: {
			enabled: false,
			remoteId: null,
		},
		...overrides,
	}) as Session;

describe('useDocumentProcessor', () => {
	beforeEach(() => {
		const readDoc = vi
			.fn()
			.mockResolvedValueOnce({ success: true, content: '# Tasks\n- [ ] Task 1' })
			.mockResolvedValueOnce({ success: true, content: '# Tasks\n- [x] Task 1' });
		const writeDoc = vi.fn().mockResolvedValue({ success: true });
		const registerSessionOrigin = vi.fn().mockResolvedValue(undefined);

		(window as typeof window & { maestro: Record<string, unknown> }).maestro = {
			...window.maestro,
			autorun: {
				...window.maestro.autorun,
				readDoc,
				writeDoc,
			},
			agentSessions: {
				...window.maestro.agentSessions,
				registerSessionOrigin,
			},
		};
	});

	it('runs planner, executor, and verifier when agentStrategy is plan-execute-verify', async () => {
		const plannerSpawn = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				response: 'Plan the implementation',
				agentSessionId: 'planner-session',
				usageStats: makeUsage({ inputTokens: 100, outputTokens: 20, totalCostUsd: 0.01 }),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'Implemented the task and updated the document.',
				agentSessionId: 'executor-session',
				usageStats: makeUsage({ inputTokens: 200, outputTokens: 30, totalCostUsd: 0.02 }),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'PASS\nLooks good.',
				agentSessionId: 'verifier-session',
				usageStats: makeUsage({ inputTokens: 50, outputTokens: 10, totalCostUsd: 0.005 }),
			});

		const { result } = renderHook(() => useDocumentProcessor());
		const taskResult = await result.current.processTask(
			{
				folderPath: '/repo/Auto Run Docs',
				session: createSession(),
				gitBranch: 'main',
				groupName: 'Test Group',
				loopIteration: 1,
				effectiveCwd: '/repo',
				customPrompt: 'Complete the first unchecked task in {{DOCUMENT_PATH}}.',
				agentStrategy: 'plan-execute-verify',
				definitionOfDone: ['Relevant tests pass'],
				verificationSteps: ['Confirm the changed task is reflected in the document'],
			},
			'phase-1',
			0,
			1,
			'# Tasks\n- [ ] Task 1',
			{
				onSpawnAgent: plannerSpawn,
			}
		);

		expect(plannerSpawn).toHaveBeenCalledTimes(3);
		expect(plannerSpawn.mock.calls[0][1]).toContain('You are the planning step');
		expect(plannerSpawn.mock.calls[1][1]).toContain('You are the execution step');
		expect(plannerSpawn.mock.calls[1][1]).toContain('## Planner Output');
		expect(plannerSpawn.mock.calls[1][3]).toEqual({ resumeAgentSessionId: 'planner-session' });
		expect(plannerSpawn.mock.calls[2][1]).toContain('You are the verification step');
		expect(plannerSpawn.mock.calls[2][1]).toContain('## Verification Steps');
		expect(plannerSpawn.mock.calls[2][1]).toContain(
			'- Confirm the changed task is reflected in the document'
		);
		expect(plannerSpawn.mock.calls[2][1]).toContain('## Definition of Done');
		expect(plannerSpawn.mock.calls[2][1]).toContain('- Relevant tests pass');
		expect(taskResult.success).toBe(true);
		expect(taskResult.agentSessionId).toBe('executor-session');
		expect(taskResult.fullSynopsis).toContain('Verifier:\nPASS');
		expect(taskResult.verifierVerdict).toBe('PASS');
		expect(taskResult.tasksCompletedThisRun).toBe(1);
		expect(taskResult.newRemainingTasks).toBe(0);
		expect(taskResult.usageStats?.inputTokens).toBe(350);
		expect(taskResult.usageStats?.outputTokens).toBe(60);
		expect(taskResult.usageStats?.totalCostUsd).toBeCloseTo(0.035, 6);
		expect(window.maestro.agentSessions.registerSessionOrigin).toHaveBeenCalledWith(
			'claude-code',
			'/repo',
			'executor-session',
			'auto'
		);
	});

	it('does not resume planner session for codex plan-execute-verify', async () => {
		const plannerSpawn = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				response: 'Plan the implementation',
				agentSessionId: 'planner-session',
				usageStats: makeUsage(),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'Implemented the task and updated the document.',
				agentSessionId: 'executor-session',
				usageStats: makeUsage(),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'PASS\nLooks good.',
				agentSessionId: 'verifier-session',
				usageStats: makeUsage(),
			});

		const { result } = renderHook(() => useDocumentProcessor());
		await result.current.processTask(
			{
				folderPath: '/repo/Auto Run Docs',
				session: createSession({ toolType: 'codex' }),
				loopIteration: 1,
				effectiveCwd: '/repo',
				customPrompt: 'Complete the first unchecked task in {{DOCUMENT_PATH}}.',
				agentStrategy: 'plan-execute-verify',
			},
			'phase-1',
			0,
			1,
			'# Tasks\n- [ ] Task 1',
			{
				onSpawnAgent: plannerSpawn,
			}
		);

		expect(plannerSpawn.mock.calls[1][3]).toBeUndefined();
	});

	it('marks the task failed when verifier returns FAIL', async () => {
		const plannerSpawn = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				response: 'Plan the implementation',
				agentSessionId: 'planner-session',
				usageStats: makeUsage(),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'Implemented the task and updated the document.',
				agentSessionId: 'executor-session',
				usageStats: makeUsage(),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'FAIL\nTests were not run.',
				agentSessionId: 'verifier-session',
				usageStats: makeUsage(),
			});

		const { result } = renderHook(() => useDocumentProcessor());
		const taskResult = await result.current.processTask(
			{
				folderPath: '/repo/Auto Run Docs',
				session: createSession(),
				loopIteration: 1,
				effectiveCwd: '/repo',
				customPrompt: 'Complete the first unchecked task in {{DOCUMENT_PATH}}.',
				agentStrategy: 'plan-execute-verify',
				definitionOfDone: ['Relevant tests pass'],
			},
			'phase-1',
			0,
			1,
			'# Tasks\n- [ ] Task 1',
			{
				onSpawnAgent: plannerSpawn,
			}
		);

		expect(taskResult.success).toBe(false);
		expect(taskResult.fullSynopsis).toContain('Verifier:\nFAIL');
		expect(taskResult.tasksCompletedThisRun).toBe(0);
		expect(taskResult.newRemainingTasks).toBe(1);
		expect(window.maestro.autorun.writeDoc).toHaveBeenLastCalledWith(
			'/repo/Auto Run Docs',
			'phase-1.md',
			'# Tasks\n- [ ] Task 1',
			undefined
		);
	});

	it('uses active-task-only document context and requested skills in the task prompt', async () => {
		const readDoc = window.maestro.autorun.readDoc as ReturnType<typeof vi.fn>;
		readDoc
			.mockReset()
			.mockResolvedValueOnce({
				success: true,
				content: '# Tasks\n\n- [x] Done task\n\n- [ ] Current task\n\n- [ ] Next task',
			})
			.mockResolvedValueOnce({
				success: true,
				content: '# Tasks\n\n- [x] Done task\n\n- [x] Current task\n\n- [ ] Next task',
			});
		const singleSpawn = vi.fn().mockResolvedValue({
			success: true,
			response: 'Updated the task.',
			agentSessionId: 'executor-session',
			usageStats: makeUsage(),
		});

		const { result } = renderHook(() => useDocumentProcessor());
		await result.current.processTask(
			{
				folderPath: '/repo/Auto Run Docs',
				session: createSession(),
				loopIteration: 1,
				effectiveCwd: '/repo',
				customPrompt: 'Complete the first unchecked task in {{DOCUMENT_PATH}}.',
				documentContextMode: 'active-task-only',
				skills: ['context-and-impact', 'gitnexus'],
				skillPromptMode: 'full',
			},
			'phase-1',
			1,
			2,
			'# Tasks\n\n- [x] Done task\n\n- [ ] Current task\n\n- [ ] Next task',
			{
				onSpawnAgent: singleSpawn,
			}
		);

		const prompt = singleSpawn.mock.calls[0][1];
		expect(prompt).toContain('## Requested Skills');
		expect(prompt).toContain('- context-and-impact');
		expect(prompt).toContain('- gitnexus');
		expect(prompt).toContain('Only the active unchecked task and minimal nearby context');
		expect(prompt).toContain('- [ ] Current task');
		expect(prompt).toContain('- [ ] Next task');
		expect(prompt).not.toContain('- [x] Done task');
	});

	it('uses full document context when requested', async () => {
		const readDoc = window.maestro.autorun.readDoc as ReturnType<typeof vi.fn>;
		readDoc
			.mockReset()
			.mockResolvedValueOnce({
				success: true,
				content: '# Tasks\n\n- [x] Done task\n\n- [ ] Current task\n\n- [ ] Next task',
			})
			.mockResolvedValueOnce({
				success: true,
				content: '# Tasks\n\n- [x] Done task\n\n- [x] Current task\n\n- [ ] Next task',
			});
		const singleSpawn = vi.fn().mockResolvedValue({
			success: true,
			response: 'Updated the task.',
			agentSessionId: 'executor-session',
			usageStats: makeUsage(),
		});

		const { result } = renderHook(() => useDocumentProcessor());
		await result.current.processTask(
			{
				folderPath: '/repo/Auto Run Docs',
				session: createSession(),
				loopIteration: 1,
				effectiveCwd: '/repo',
				customPrompt: 'Complete the first unchecked task in {{DOCUMENT_PATH}}.',
				documentContextMode: 'full',
			},
			'phase-1',
			1,
			2,
			'# Tasks\n\n- [x] Done task\n\n- [ ] Current task\n\n- [ ] Next task',
			{
				onSpawnAgent: singleSpawn,
			}
		);

		const prompt = singleSpawn.mock.calls[0][1];
		expect(prompt).toContain('The full document is inlined below.');
		expect(prompt).toContain('- [x] Done task');
		expect(prompt).toContain('- [ ] Current task');
		expect(prompt).toContain('- [ ] Next task');
	});

	it('prefixes the summary when verifier returns WARN', async () => {
		const plannerSpawn = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				response: 'Plan the implementation',
				agentSessionId: 'planner-session',
				usageStats: makeUsage(),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'Implemented the task and updated the document.',
				agentSessionId: 'executor-session',
				usageStats: makeUsage(),
			})
			.mockResolvedValueOnce({
				success: true,
				response: 'WARN\nImplementation looks correct but tests were skipped.',
				agentSessionId: 'verifier-session',
				usageStats: makeUsage(),
			});

		const { result } = renderHook(() => useDocumentProcessor());
		const taskResult = await result.current.processTask(
			{
				folderPath: '/repo/Auto Run Docs',
				session: createSession(),
				loopIteration: 1,
				effectiveCwd: '/repo',
				customPrompt: 'Complete the first unchecked task in {{DOCUMENT_PATH}}.',
				agentStrategy: 'plan-execute-verify',
			},
			'phase-1',
			0,
			1,
			'# Tasks\n- [ ] Task 1',
			{
				onSpawnAgent: plannerSpawn,
			}
		);

		expect(taskResult.success).toBe(true);
		expect(taskResult.verifierVerdict).toBe('WARN');
		expect(taskResult.shortSummary).toMatch(/^\[WARN\]/);
	});
});
