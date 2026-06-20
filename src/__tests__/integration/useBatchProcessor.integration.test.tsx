import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	AgentError,
	BatchDocumentEntry,
	BatchRunConfig,
	BatchRunState,
	Group,
	Session,
} from '../../renderer/types';
import { DEFAULT_BATCH_STATE } from '../../renderer/hooks/batch/batchReducer';
import { useBatchProcessor } from '../../renderer/hooks/batch/useBatchProcessor';
import { createLoopSummaryEntry } from '../../renderer/hooks/batch/internal/batchLoopSummary';
import { useBatchStore } from '../../renderer/stores/batchStore';
import { useNotificationStore } from '../../renderer/stores/notificationStore';
import { useSessionStore } from '../../renderer/stores/sessionStore';

const createSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Planner',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/repo/main',
	projectRoot: '/repo/main',
	aiPid: 0,
	terminalPid: 0,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	...overrides,
});

const createGroup = (overrides: Partial<Group> = {}): Group => ({
	id: 'group-1',
	name: 'Delivery',
	collapsed: false,
	...overrides,
});

const createDocument = (
	filename: string,
	overrides: Partial<BatchDocumentEntry> = {}
): BatchDocumentEntry => ({
	id: `doc-${filename}`,
	filename,
	resetOnCompletion: false,
	isDuplicate: false,
	...overrides,
});

const createRunningBatchState = (overrides: Partial<BatchRunState> = {}): BatchRunState => ({
	...DEFAULT_BATCH_STATE,
	isRunning: true,
	processingState: 'RUNNING',
	documents: ['plan'],
	lockedDocuments: ['plan'],
	currentDocTasksTotal: 1,
	totalTasksAcrossAllDocs: 1,
	folderPath: '/repo/main/.maestro/auto-run',
	totalTasks: 1,
	startTime: Date.now(),
	accumulatedElapsedMs: 0,
	lastActiveTimestamp: Date.now(),
	...overrides,
});

const setDocumentHidden = (hidden: boolean): void => {
	Object.defineProperty(document, 'hidden', {
		configurable: true,
		value: hidden,
	});
};

describe('useBatchProcessor integration', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleWarn: ReturnType<typeof vi.spyOn>;
	let consoleError: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		useBatchStore.setState({
			batchRunStates: {},
			customPrompts: {},
			documentList: [],
			documentTree: [],
			isLoadingDocuments: false,
			documentTaskCounts: new Map(),
		});
		useSessionStore.setState({ sessions: [] });
		useNotificationStore.getState().clearToasts();

		window.maestro = {
			...window.maestro,
			autorun: {
				...window.maestro.autorun,
				readDoc: vi.fn(),
				writeDoc: vi.fn().mockResolvedValue({ success: true }),
				createWorkingCopy: vi
					.fn()
					.mockResolvedValue({ workingCopyPath: 'Runs/tasks-loop-00001.md' }),
			},
			git: {
				...window.maestro.git,
				status: vi.fn().mockResolvedValue({ stdout: '' }),
				branch: vi.fn().mockResolvedValue({ stdout: 'feature/integration' }),
				worktreeSetup: vi.fn().mockResolvedValue({ success: true, branchMismatch: false }),
				worktreeCheckout: vi.fn().mockResolvedValue({ success: true }),
				getDefaultBranch: vi.fn().mockResolvedValue({ success: true, branch: 'main' }),
				log: vi.fn().mockResolvedValue({
					entries: [{ subject: 'complete Auto Run task' }],
					error: undefined,
				}),
				createPR: vi
					.fn()
					.mockResolvedValue({ success: true, prUrl: 'https://github.com/acme/app/pull/9' }),
			},
			web: {
				...window.maestro.web,
				broadcastAutoRunState: vi.fn(),
			},
			agentSessions: {
				...window.maestro.agentSessions,
				registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
			},
			process: {
				...window.maestro.process,
				kill: vi.fn().mockResolvedValue(true),
			},
			power: {
				...window.maestro.power,
				addReason: vi.fn(),
				removeReason: vi.fn(),
			},
			stats: {
				...window.maestro.stats,
				startAutoRun: vi.fn().mockResolvedValue('auto-run-1'),
				recordAutoTask: vi.fn().mockResolvedValue('task-1'),
				endAutoRun: vi.fn().mockResolvedValue(true),
			},
			symphony: {
				...window.maestro.symphony,
				updateStatus: vi.fn().mockResolvedValue({ success: true }),
			},
			notification: {
				...window.maestro.notification,
				show: vi.fn().mockResolvedValue(undefined),
				speak: vi.fn().mockResolvedValue({ success: true, notificationId: 1 }),
			},
			logger: {
				...window.maestro.logger,
				log: vi.fn(),
				autorun: vi.fn(),
				toast: vi.fn(),
			},
		};
	});

	afterEach(() => {
		cleanup();
		useNotificationStore.getState().clearToasts();
		useBatchStore.setState({ batchRunStates: {}, customPrompts: {} });
		useSessionStore.setState({ sessions: [] });
		setDocumentHidden(false);
		consoleLog.mockRestore();
		consoleWarn.mockRestore();
		consoleError.mockRestore();
		vi.restoreAllMocks();
	});

	it('formats loop summary history entries with optional usage and exit details', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-26T23:15:00.000Z'));

		try {
			const withUsage = createLoopSummaryEntry({
				loopIteration: 1,
				loopTasksCompleted: 2,
				loopStartTime: Date.now() - 65_000,
				loopTotalInputTokens: 1000,
				loopTotalOutputTokens: 250,
				loopTotalCost: 0.12345,
				sessionCwd: '/repo/main',
				sessionId: 'session-1',
				isFinal: true,
				exitReason: 'Reached max loop limit (2)',
			});
			const withoutUsage = createLoopSummaryEntry({
				loopIteration: 0,
				loopTasksCompleted: 1,
				loopStartTime: Date.now() - 5000,
				loopTotalInputTokens: 0,
				loopTotalOutputTokens: 0,
				loopTotalCost: 0,
				sessionCwd: '/repo/main',
				sessionId: 'session-1',
				isFinal: false,
			});

			expect(withUsage).toMatchObject({
				type: 'AUTO',
				summary: 'Loop 2 (final) completed: 2 tasks accomplished',
				projectPath: '/repo/main',
				sessionId: 'session-1',
				success: true,
				usageStats: expect.objectContaining({
					inputTokens: 1000,
					outputTokens: 250,
					totalCostUsd: 0.12345,
				}),
			});
			expect(withUsage.fullResponse).toContain('**Loop 2 (final) Summary**');
			expect(withUsage.fullResponse).toContain('1,250');
			expect(withUsage.fullResponse).toContain('$0.1235');
			expect(withUsage.fullResponse).toContain('Reached max loop limit (2)');
			expect(withoutUsage.summary).toBe('Loop 1 completed: 1 task accomplished');
			expect(withoutUsage.usageStats).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it('runs one document through the real batch/document/store flow and records completion', async () => {
		let taskCompleted = false;
		const session = createSession({ groupId: 'group-1' });
		const groups = [createGroup()];
		const onUpdateSession = vi.fn();
		const onAddHistoryEntry = vi.fn();
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt, cwdOverride) => {
			taskCompleted = true;
			return {
				success: true,
				agentSessionId: 'claude-auto-1',
				response: '**Summary:** Finished the first task. Detailed notes follow.',
				usageStats: {
					inputTokens: 11,
					outputTokens: 17,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.03,
					contextWindow: 200000,
				},
				cwdOverride,
				prompt,
			};
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async () => ({
			success: true,
			content: taskCompleted
				? '# Plan for Planner\n- [x] Ship integration test'
				: '# Plan for {{AGENT_NAME}}\n- [ ] Ship integration test',
		}));
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups,
				onUpdateSession,
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [{ filename: 'plan' }],
					prompt: 'Work on {{DOCUMENT_NAME}} from {{AGENT_GROUP}} on {{GIT_BRANCH}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledWith(
			session.id,
			'Work on plan from Delivery on feature/integration',
			undefined
		);
		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/main/.maestro/auto-run',
			'plan.md',
			'# Plan for Planner\n- [ ] Ship integration test',
			undefined
		);
		expect(window.maestro.agentSessions.registerSessionOrigin).toHaveBeenCalledWith(
			'/repo/main',
			'claude-auto-1',
			'auto'
		);
		expect(window.maestro.stats.recordAutoTask).toHaveBeenCalledWith(
			expect.objectContaining({
				autoRunSessionId: 'auto-run-1',
				sessionId: session.id,
				taskIndex: 0,
				success: true,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: expect.stringContaining('Auto Run completed: 1 task'),
				success: true,
				usageStats: expect.objectContaining({
					inputTokens: 11,
					outputTokens: 17,
					totalCostUsd: 0.03,
				}),
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 1,
				wasStopped: false,
				documentsProcessed: 1,
			})
		);
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			processingState: 'IDLE',
			sessionIds: ['claude-auto-1'],
		});
		expect(useNotificationStore.getState().toasts[0]).toMatchObject({
			type: 'info',
			title: 'Auto Run Started',
			project: 'Planner',
		});
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenLastCalledWith(session.id, null);
		expect(window.maestro.power.addReason).toHaveBeenCalledWith(`autorun:${session.id}`);
		expect(window.maestro.power.removeReason).toHaveBeenCalledWith(`autorun:${session.id}`);
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('integrates worktree setup and PR creation after successful Auto Run completion', async () => {
		let taskCompleted = false;
		const session = createSession();
		const onPRResult = vi.fn();
		const onAddHistoryEntry = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			taskCompleted = true;
			return {
				success: true,
				agentSessionId: 'claude-worktree-1',
				response: '**Summary:** Finished worktree task.',
				usageStats: {
					inputTokens: 5,
					outputTokens: 8,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
					contextWindow: 200000,
				},
			};
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async () => ({
			success: true,
			content: taskCompleted ? '- [x] Open PR' : '- [ ] Open PR',
		}));
		vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValue({
			success: true,
			branchMismatch: true,
		});
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete: vi.fn(),
				onPRResult,
			})
		);
		const config: BatchRunConfig = {
			documents: [{ filename: 'release' }],
			prompt: 'Finish release',
			loopEnabled: false,
			worktree: {
				enabled: true,
				path: '/repo/release-worktree',
				branchName: 'feature/release',
				createPROnCompletion: true,
				prTargetBranch: 'develop',
				ghPath: '/usr/local/bin/gh',
			},
		};

		await act(async () => {
			await result.current.startBatchRun(session.id, config, '/repo/main/.maestro/auto-run');
		});

		await waitFor(() => {
			expect(onPRResult).toHaveBeenCalledWith({
				sessionId: session.id,
				sessionName: 'Planner',
				success: true,
				prUrl: 'https://github.com/acme/app/pull/9',
				error: undefined,
			});
		});
		expect(window.maestro.git.worktreeSetup).toHaveBeenCalledWith(
			'/repo/main',
			'/repo/release-worktree',
			'feature/release',
			undefined,
			undefined
		);
		expect(window.maestro.git.worktreeCheckout).toHaveBeenCalledWith(
			'/repo/release-worktree',
			'feature/release',
			true,
			undefined
		);
		expect(onSpawnAgent).toHaveBeenCalledWith(
			session.id,
			'Finish release',
			'/repo/release-worktree'
		);
		expect(window.maestro.git.createPR).toHaveBeenCalledWith(
			'/repo/release-worktree',
			'develop',
			'feature/release: 1 task completed in release',
			expect.stringContaining('complete Auto Run task'),
			'/usr/local/bin/gh'
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Auto Run started in worktree',
				projectPath: '/repo/release-worktree',
				success: true,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'PR created: https://github.com/acme/app/pull/9',
				projectPath: '/repo/release-worktree',
				success: true,
			})
		);
		expect(consoleWarn).not.toHaveBeenCalled();
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('uses an existing worktree target without re-running worktree setup and opens a PR from the parent repo', async () => {
		let taskCompleted = false;
		const parentSession = createSession({ id: 'parent-session', cwd: '/repo/main' });
		const worktreeSession = createSession({
			id: 'worktree-session',
			cwd: '/repo/feature-worktree',
			parentSessionId: 'parent-session',
			worktreeBranch: 'feature/existing',
		});
		const onPRResult = vi.fn();
		const onAddHistoryEntry = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			taskCompleted = true;
			return {
				success: true,
				agentSessionId: 'claude-existing-worktree-1',
				response: '**Summary:** Finished existing worktree task.',
				usageStats: {
					inputTokens: 6,
					outputTokens: 9,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.02,
					contextWindow: 200000,
				},
			};
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async () => ({
			success: true,
			content: taskCompleted ? '- [x] Existing worktree task' : '- [ ] Existing worktree task',
		}));
		useSessionStore.setState({
			sessions: [parentSession, worktreeSession],
			activeSessionId: worktreeSession.id,
		});

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [parentSession, worktreeSession],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete: vi.fn(),
				onPRResult,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				worktreeSession.id,
				{
					documents: [createDocument('existing')],
					prompt: 'Finish existing worktree',
					loopEnabled: false,
					worktree: {
						enabled: true,
						path: '/repo/feature-worktree',
						branchName: 'feature/existing',
						createPROnCompletion: true,
						prTargetBranch: '',
						ghPath: '/usr/local/bin/gh',
					},
					worktreeTarget: {
						mode: 'existing-open',
						sessionId: worktreeSession.id,
						worktreePath: '/repo/feature-worktree',
						createPROnCompletion: true,
					},
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();
		expect(window.maestro.git.worktreeCheckout).not.toHaveBeenCalled();
		expect(onSpawnAgent).toHaveBeenCalledWith(
			worktreeSession.id,
			'Finish existing worktree',
			undefined
		);
		expect(window.maestro.git.getDefaultBranch).toHaveBeenCalledWith('/repo/main');
		expect(window.maestro.git.createPR).toHaveBeenCalledWith(
			'/repo/feature-worktree',
			'main',
			'feature/existing: 1 task completed in existing',
			expect.stringContaining('complete Auto Run task'),
			'/usr/local/bin/gh'
		);
		expect(onPRResult).toHaveBeenCalledWith({
			sessionId: worktreeSession.id,
			sessionName: 'Planner',
			success: true,
			prUrl: 'https://github.com/acme/app/pull/9',
			error: undefined,
		});
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Auto Run started in worktree',
				projectPath: '/repo/feature-worktree',
			})
		);
	});

	it('records failed worktree PR creation with fallback repo and session details', async () => {
		const sessions = [
			createSession({
				id: 'worktree-no-parent',
				name: '',
				cwd: '/repo/orphan-worktree/',
				isGitRepo: false,
				parentSessionId: 'missing-parent',
				worktreeBranch: 'feature/orphan',
			}),
			createSession({
				id: 'worktree-default-throws',
				name: '',
				cwd: '/repo/default-throws/',
				isGitRepo: false,
				parentSessionId: 'missing-parent',
				worktreeBranch: 'feature/default-throws',
			}),
		];
		const completedDocs = new Set<string>();
		const onPRResult = vi.fn();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async (sessionId: string) => {
			completedDocs.add(sessionId);
			return {
				success: true,
				agentSessionId: `${sessionId}-agent`,
				response: '**Summary:** Finished the PR failure branch.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => {
			const docKey = filename.replace(/\.md$/, '');
			const sessionId = docKey === 'orphan' ? 'worktree-no-parent' : 'worktree-default-throws';
			return {
				success: true,
				content: completedDocs.has(sessionId) ? `- [x] Finish ${docKey}` : `- [ ] Finish ${docKey}`,
			};
		});
		vi.mocked(window.maestro.git.createPR).mockResolvedValueOnce({ success: false });
		vi.mocked(window.maestro.git.getDefaultBranch)
			.mockResolvedValueOnce({ success: true, branch: 'main' })
			.mockRejectedValueOnce('default branch unavailable');
		useSessionStore.setState({ sessions });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions,
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
				onPRResult,
			})
		);
		const runConfig = (session: Session, filename: string): BatchRunConfig => ({
			documents: [createDocument(filename)],
			prompt: `Finish ${filename}`,
			loopEnabled: false,
			worktree: {
				enabled: true,
				path: session.cwd,
				branchName: session.worktreeBranch,
				createPROnCompletion: true,
				prTargetBranch: '',
				ghPath: '/usr/local/bin/gh',
			},
			worktreeTarget: {
				mode: 'existing-open',
				sessionId: session.id,
				worktreePath: session.cwd,
				createPROnCompletion: true,
			},
		});

		await act(async () => {
			await result.current.startBatchRun(
				sessions[0].id,
				runConfig(sessions[0], 'orphan'),
				'/repo/main/.maestro/auto-run'
			);
			await result.current.startBatchRun(
				sessions[1].id,
				runConfig(sessions[1], 'default-throws'),
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();
		expect(window.maestro.git.getDefaultBranch).toHaveBeenNthCalledWith(
			1,
			'/repo/orphan-worktree/'
		);
		expect(window.maestro.git.getDefaultBranch).toHaveBeenNthCalledWith(2, '/repo/default-throws/');
		expect(window.maestro.git.createPR).toHaveBeenCalledWith(
			'/repo/orphan-worktree/',
			'main',
			'feature/orphan: 1 task completed in orphan',
			expect.stringContaining('**Documents processed:**'),
			'/usr/local/bin/gh'
		);
		expect(onPRResult).toHaveBeenCalledWith({
			sessionId: 'worktree-no-parent',
			sessionName: 'Unknown',
			success: false,
			prUrl: undefined,
			error: undefined,
		});
		expect(onPRResult).toHaveBeenCalledWith({
			sessionId: 'worktree-default-throws',
			sessionName: 'Unknown',
			success: false,
			prUrl: undefined,
			error: 'Unknown error',
		});

		const historyEntries = onAddHistoryEntry.mock.calls.map(([entry]) => entry);
		expect(historyEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					summary: 'PR creation failed: Unknown error',
					fullResponse: expect.stringContaining('- **Target:** `main`'),
					projectPath: '/repo/orphan-worktree/',
					success: false,
				}),
				expect.objectContaining({
					summary: 'PR creation failed: Unknown error',
					fullResponse: expect.stringContaining('- **Target:** `unknown`'),
					projectPath: '/repo/default-throws/',
					success: false,
				}),
			])
		);
		const finalSummary = historyEntries.find(
			(entry) =>
				entry.sessionId === 'worktree-no-parent' &&
				entry.summary.startsWith('Auto Run completed: 1 task')
		);
		expect(finalSummary).toMatchObject({
			success: true,
			usageStats: undefined,
		});
		expect(finalSummary.fullResponse).not.toContain('Total Tokens');
		expect(finalSummary.fullResponse).not.toContain('Total Cost');
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: 'worktree-no-parent',
				sessionName: 'Unknown',
				completedTasks: 1,
				inputTokens: 0,
				outputTokens: 0,
				totalCostUsd: 0,
			})
		);
	});

	it('uses worktree targets with empty prompts, optional callbacks, and max-level summaries', async () => {
		const docs = new Map<string, string>([
			['done-plain.md', '- [x] Already covered'],
			['empty-reset.md', 'No tasks here'],
			['fallback.md', '- [ ] Finish fallback worktree'],
			['no-max.md', '- [ ] Finish no max worktree'],
		]);
		const sessions = [
			createSession({
				id: 'worktree-fallback',
				cwd: '/repo/fallback-worktree',
				projectRoot: '/repo/fallback-worktree',
				worktreeBranch: undefined,
			}),
			createSession({
				id: 'worktree-no-max',
				cwd: '/repo/no-max-worktree',
				projectRoot: '/repo/no-max-worktree',
				worktreeBranch: undefined,
			}),
		];
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const completedByCall = ['fallback.md', 'no-max.md'];
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			const filename = completedByCall[onSpawnAgent.mock.calls.length - 1];
			docs.set(filename, docs.get(filename)!.replace('- [ ]', '- [x]'));
			return {
				success: true,
				response: '**Summary:** Finished without an agent session id.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions,
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				autoRunStats: {
					cumulativeTimeMs: 3650 * 24 * 60 * 60 * 1000,
					longestRunMs: 0,
					longestRunTimestamp: 0,
					totalRuns: 99,
					currentBadgeLevel: 11,
					lastBadgeUnlockLevel: 11,
					lastAcknowledgedBadgeLevel: 11,
					badgeHistory: [],
				},
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				sessions[0].id,
				{
					documents: [
						createDocument('done-plain'),
						createDocument('empty-reset', { resetOnCompletion: true }),
						createDocument('fallback'),
					],
					prompt: '',
					loopEnabled: true,
					maxLoops: 2,
					worktree: {
						enabled: true,
						path: '/repo/fallback-worktree',
						branchName: 'feature/fallback-branch',
						createPROnCompletion: true,
						prTargetBranch: 'main',
						ghPath: '/usr/local/bin/gh',
					},
					worktreeTarget: {
						mode: 'existing-open',
						sessionId: sessions[0].id,
						worktreePath: '/repo/fallback-worktree',
						createPROnCompletion: true,
					},
				},
				'/repo/main/.maestro/auto-run'
			);
			await result.current.startBatchRun(
				sessions[1].id,
				{
					documents: [createDocument('no-max')],
					prompt: '',
					loopEnabled: true,
					maxLoops: null,
					worktree: {
						enabled: true,
						path: '/repo/no-max-worktree',
						branchName: 'feature/no-max-branch',
						createPROnCompletion: false,
					},
					worktreeTarget: {
						mode: 'existing-open',
						sessionId: sessions[1].id,
						worktreePath: '/repo/no-max-worktree',
						createPROnCompletion: false,
					},
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(window.maestro.git.worktreeSetup).not.toHaveBeenCalled();
		expect(onSpawnAgent).toHaveBeenNthCalledWith(1, sessions[0].id, '', undefined);
		expect(onSpawnAgent).toHaveBeenNthCalledWith(2, sessions[1].id, '', undefined);
		expect(window.maestro.git.createPR).toHaveBeenCalledWith(
			'/repo/fallback-worktree',
			'main',
			expect.stringContaining('feature/fallback-branch: 1 task across done-plain'),
			expect.any(String),
			'/usr/local/bin/gh'
		);

		const historyEntries = onAddHistoryEntry.mock.calls.map(([entry]) => entry);
		expect(historyEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					summary: 'Auto Run started in worktree',
					fullResponse: expect.stringContaining('- **Loop Mode:** Enabled (max 2)'),
					projectPath: '/repo/fallback-worktree',
				}),
				expect.objectContaining({
					summary: 'Auto Run started in worktree',
					fullResponse: expect.stringContaining('- **Loop Mode:** Enabled'),
					projectPath: '/repo/no-max-worktree',
				}),
				expect.objectContaining({
					summary: expect.stringMatching(/^Auto Run completed: 1 task/),
					fullResponse: expect.stringContaining('Maximum level achieved'),
				}),
			])
		);
		expect(useBatchStore.getState().batchRunStates[sessions[0].id].sessionIds).toEqual([]);
	});

	it('exposes batch selectors, custom prompts, and startup guard rails', async () => {
		const session = createSession();
		const stoppingSessionId = 'session-stopping';
		useSessionStore.setState({ sessions: [session] });
		useBatchStore.getState().setBatchRunStates({
			[session.id]: createRunningBatchState(),
			[stoppingSessionId]: createRunningBatchState({
				isStopping: true,
				processingState: 'STOPPING',
			}),
		});

		const onSpawnAgent = vi.fn().mockResolvedValue({ success: true });
		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete: vi.fn(),
			})
		);

		expect(result.current.hasAnyActiveBatch).toBe(true);
		expect(result.current.activeBatchSessionIds).toEqual([session.id, stoppingSessionId]);
		expect(result.current.stoppingBatchSessionIds).toEqual([stoppingSessionId]);
		expect(result.current.getBatchState(session.id)).toMatchObject({
			isRunning: true,
			totalTasksAcrossAllDocs: 1,
		});
		expect(result.current.getBatchState('missing')).toEqual(DEFAULT_BATCH_STATE);

		act(() => {
			result.current.setCustomPrompt(session.id, 'Review the integration plan');
		});
		expect(useBatchStore.getState().customPrompts[session.id]).toBe('Review the integration plan');

		await act(async () => {
			await result.current.startBatchRun(
				'missing-session',
				{
					documents: [createDocument('missing')],
					prompt: 'Run missing session',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			expect.stringContaining('Session not found for batch processing'),
			'BatchProcessor',
			expect.objectContaining({ sessionId: 'missing-session' })
		);
		await act(async () => {
			await result.current.startBatchRun(
				'missing-closed-worktree',
				{
					documents: [createDocument('missing-closed')],
					prompt: 'Run missing closed worktree session',
					loopEnabled: false,
					worktreeTarget: {
						mode: 'existing-closed',
						worktreePath: '/repo/closed-worktree',
						createPROnCompletion: false,
					},
				},
				'/repo/main/.maestro/auto-run'
			);
			await result.current.startBatchRun(
				'missing-new-worktree',
				{
					documents: [createDocument('missing-new')],
					prompt: 'Run missing new worktree session',
					loopEnabled: false,
					worktreeTarget: {
						mode: 'create-new',
						newBranchName: 'feature/new-worktree',
						createPROnCompletion: false,
					},
				},
				'/repo/main/.maestro/auto-run'
			);
			await result.current.startBatchRun(
				'missing-open-worktree',
				{
					documents: [createDocument('missing-open')],
					prompt: 'Run missing open worktree session',
					loopEnabled: false,
					worktreeTarget: {
						mode: 'existing-open',
						sessionId: 'open-worktree-session',
						createPROnCompletion: false,
					},
				},
				'/repo/main/.maestro/auto-run'
			);
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			expect.stringContaining(
				'Session not found for batch processing (worktree mode: existing-closed, path: /repo/closed-worktree)'
			),
			'BatchProcessor',
			expect.objectContaining({ worktreeTargetMode: 'existing-closed' })
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			expect.stringContaining(
				'Session not found for batch processing (worktree mode: create-new, path: feature/new-worktree)'
			),
			'BatchProcessor',
			expect.objectContaining({ worktreeTargetMode: 'create-new' })
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			expect.stringContaining(
				'Session not found for batch processing (worktree mode: existing-open, path: open-worktree-session)'
			),
			'BatchProcessor',
			expect.objectContaining({ worktreeTargetMode: 'existing-open' })
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [],
					prompt: 'Run empty batch',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'No documents provided for batch processing',
			'BatchProcessor',
			{ sessionId: session.id }
		);

		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValueOnce({
			success: true,
			content: '- [x] Already done',
		});
		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('done')],
					prompt: 'Run completed batch',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'No unchecked tasks found across all documents',
			'BatchProcessor',
			{ sessionId: session.id }
		);

		vi.mocked(window.maestro.git.worktreeSetup).mockResolvedValueOnce({
			success: false,
			error: 'worktree path unavailable',
		});
		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('worktree')],
					prompt: 'Run worktree batch',
					loopEnabled: false,
					worktree: {
						enabled: true,
						path: '/repo/worktree',
						branchName: 'feature/worktree',
					},
				},
				'/repo/main/.maestro/auto-run'
			);
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Worktree setup failed',
			'BatchProcessor',
			expect.objectContaining({
				sessionId: session.id,
				error: 'worktree path unavailable',
			})
		);
		expect(onSpawnAgent).not.toHaveBeenCalled();
	});

	it('handles reset documents, stalled documents, loop summaries, and recoverable telemetry failures', async () => {
		const docs = new Map<string, string>([
			['checked-reset.md', '- [x] Reset me'],
			['loop.md', '- [ ] Repeatable task'],
			['stuck.md', '- [ ] Clarify stalled task'],
			['finish.md', '- [ ] Finish the integration slice'],
		]);
		const session = createSession({
			symphonyMetadata: {
				isSymphonySession: true,
				contributionId: 'contribution-1',
				repoSlug: 'owner/repo',
				issueNumber: 42,
				issueTitle: 'Cover batch processor',
				documentPaths: ['loop.md', 'stuck.md', 'finish.md'],
				status: 'running',
			},
		});
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onProcessQueueAfterCompletion = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt: string) => {
			if (prompt.includes('loop-loop-1')) {
				docs.set('Runs/loop-loop-1.md', '- [x] Repeatable task');
			}
			if (prompt.includes('finish')) {
				docs.set('finish.md', '- [x] Finish the integration slice');
			}

			return {
				success: true,
				agentSessionId: `claude-loop-${onSpawnAgent.mock.calls.length}`,
				response: '**Summary:** Agent attempted the current Auto Run task.',
				usageStats: {
					inputTokens: 3,
					outputTokens: 4,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.02,
					contextWindow: 200000,
				},
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.writeDoc).mockImplementation(
			async (_folder, filename, content) => {
				docs.set(filename, content);
				return { success: true };
			}
		);
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		vi.mocked(window.maestro.stats.recordAutoTask).mockRejectedValue(new Error('record failed'));
		vi.mocked(window.maestro.stats.endAutoRun).mockRejectedValue(new Error('end failed'));
		vi.mocked(window.maestro.symphony.updateStatus).mockRejectedValue(
			new Error('symphony offline')
		);
		vi.mocked(window.maestro.notification.speak).mockRejectedValue(new Error('tts failed'));
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
				audioFeedbackEnabled: true,
				audioFeedbackCommand: 'say',
				onProcessQueueAfterCompletion,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [
						createDocument('checked-reset', { resetOnCompletion: true }),
						createDocument('loop', { resetOnCompletion: true }),
						createDocument('stuck'),
						createDocument('finish'),
					],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 1,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		await waitFor(() => {
			expect(onProcessQueueAfterCompletion).toHaveBeenCalledWith(session.id);
		});
		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'warn',
				'[BatchProcessor] Failed to update Symphony progress:',
				undefined,
				expect.any(Error)
			);
		});
		await waitFor(() => {
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'[BatchProcessor] Failed to speak synopsis:',
				undefined,
				expect.any(Error)
			);
		});

		expect(window.maestro.autorun.writeDoc).toHaveBeenCalledWith(
			'/repo/main/.maestro/auto-run',
			'checked-reset.md',
			'- [ ] Reset me',
			undefined
		);
		expect(window.maestro.autorun.createWorkingCopy).toHaveBeenCalledWith(
			'/repo/main/.maestro/auto-run',
			'loop',
			1,
			undefined
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Document loop completed: loop',
			session.name,
			expect.objectContaining({
				document: 'loop',
				workingCopy: 'Runs/loop-loop-1',
				tasksCompleted: 1,
			})
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Document stalled: stuck',
			session.name,
			expect.objectContaining({
				document: 'stuck',
				reason: '3 consecutive runs with no progress',
				remainingTasks: 1,
			})
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run exiting: Reached max loop limit (1)',
			session.name,
			expect.objectContaining({
				reason: 'Reached max loop limit (1)',
				totalTasksCompleted: 2,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Document stalled: stuck (1 tasks remaining)',
				success: false,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 1 (final) completed: 2 tasks accomplished',
				success: true,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: expect.stringMatching(/^Auto Run completed with stalls: 2 tasks/),
				fullResponse: expect.stringContaining('**Stalled Documents**'),
				success: true,
				usageStats: expect.objectContaining({
					inputTokens: 15,
					outputTokens: 20,
					totalCostUsd: 0.1,
				}),
			})
		);
		expect(window.maestro.stats.recordAutoTask).toHaveBeenCalledTimes(2);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[BatchProcessor] Failed to record task stats:',
			undefined,
			expect.any(Error)
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[BatchProcessor] Failed to end stats tracking:',
			undefined,
			expect.any(Error)
		);
		expect(window.maestro.symphony.updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				contributionId: 'contribution-1',
				progress: expect.objectContaining({ currentDocument: 'loop' }),
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 2,
				totalTasks: 4,
				wasStopped: false,
				documentsProcessed: 4,
				inputTokens: 15,
				outputTokens: 20,
				totalCostUsd: 0.1,
			})
		);
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			processingState: 'IDLE',
		});
	});

	it('marks the run stalled when every document stops making progress', async () => {
		const session = createSession();
		const docs = new Map<string, string>([['blocked.md', '- [ ] Resolve blocked task']]);
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockResolvedValue({
			success: true,
			agentSessionId: 'claude-stalled-1',
			response: '**Summary:** Attempted the blocked task but made no file changes.',
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('blocked')],
					prompt: 'Try to resolve the blocked task',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(3);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Document stalled: blocked',
			session.name,
			expect.objectContaining({
				document: 'blocked',
				reason: '3 consecutive runs with no progress',
				remainingTasks: 1,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Document stalled: blocked (1 tasks remaining)',
				fullResponse: expect.stringContaining('No more documents to process.'),
				success: false,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: expect.stringMatching(/^Auto Run stalled: 0 tasks/),
				fullResponse: expect.stringContaining(
					'Stalled - All 1 document(s) stopped making progress'
				),
				success: false,
				usageStats: undefined,
			})
		);
		expect(window.maestro.stats.recordAutoTask).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 0,
				totalTasks: 1,
				wasStopped: false,
				documentsProcessed: 1,
			})
		);
	});

	it('stops after the current task and records a stopped loop summary', async () => {
		const docs = new Map<string, string>([['multi.md', '- [ ] First task\n- [ ] Second task']]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			docs.set('multi.md', '- [x] First task\n- [ ] Second task');
			resultRef!.current.stopBatchRun(session.id);
			return {
				success: true,
				agentSessionId: 'claude-stop-1',
				response: '**Summary:** Finished one task before stopping.',
				usageStats: {
					inputTokens: 2,
					outputTokens: 3,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
					contextWindow: 200000,
				},
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('multi')],
					prompt: 'Stop after one task',
					loopEnabled: true,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run exiting: Stopped by user',
			session.name,
			expect.objectContaining({
				reason: 'Stopped by user',
				totalTasksCompleted: 1,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 1 (final) completed: 1 task accomplished',
				fullResponse: expect.stringContaining('Stopped by user'),
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: expect.stringMatching(/^Auto Run stopped: 1 task/),
				fullResponse: expect.stringContaining('- **Status:** Stopped by user'),
				success: false,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 2,
				wasStopped: true,
			})
		);
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({ isStopping: true })
		);
		expect(window.maestro.power.removeReason).toHaveBeenCalledWith(`autorun:${session.id}`);
	});

	it('resumes the processing loop after a recoverable agent error', async () => {
		const docs = new Map<string, string>([['recover.md', '- [ ] Recover task']]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		let shouldFail = true;
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Agent crashed',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 456,
			raw: { exitCode: 1, stderr: 'crash' },
		};
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			if (shouldFail) {
				shouldFail = false;
				resultRef!.current.pauseBatchOnError(session.id, agentError, 0, 'Recover task');
				setTimeout(() => {
					resultRef!.current.resumeAfterError(session.id);
				}, 0);
				throw new Error('agent crashed');
			}

			docs.set('recover.md', '- [x] Recover task');
			return {
				success: true,
				agentSessionId: 'claude-recovered-1',
				response: '**Summary:** Recovered and completed the task.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('recover')],
					prompt: 'Recover after crash',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(2);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			`[BatchProcessor] Error running task in recover for session ${session.id}:`,
			undefined,
			expect.any(Error)
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run paused due to agent_crashed: Agent crashed',
			session.id,
			expect.objectContaining({
				errorType: 'agent_crashed',
				taskDescription: 'Recover task',
			})
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Resuming Auto Run after error resolution',
			session.id,
			{}
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Recovered and completed the task.',
				success: true,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 1,
				wasStopped: false,
			})
		);
	});

	it('integrates stop, kill, and error-resolution controls with batch state broadcasts', async () => {
		const session = createSession();
		useSessionStore.setState({ sessions: [session] });
		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent: vi.fn().mockResolvedValue({ success: true }),
				onAddHistoryEntry: vi.fn(),
				onComplete: vi.fn(),
			})
		);
		const seedRunningState = () => {
			act(() => {
				useBatchStore.getState().setBatchRunStates({
					[session.id]: createRunningBatchState(),
				});
			});
		};
		const agentError: AgentError = {
			type: 'token_exhaustion',
			message: 'Context limit reached',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 123,
			raw: { stderr: 'context limit' },
		};

		seedRunningState();
		act(() => {
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Ship integration test');
		});
		await waitFor(() => {
			expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
				errorPaused: true,
				error: agentError,
				errorDocumentIndex: 0,
				errorTaskDescription: 'Ship integration test',
			});
		});
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run paused due to token_exhaustion: Context limit reached',
			session.id,
			expect.objectContaining({
				errorType: 'token_exhaustion',
				documentIndex: 0,
			})
		);
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({
				isRunning: true,
				isStopping: false,
				totalTasks: 1,
				totalDocuments: 1,
			})
		);

		act(() => {
			result.current.resumeAfterError(session.id);
		});
		await waitFor(() => {
			expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
				errorPaused: false,
				error: undefined,
			});
		});

		act(() => {
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Retry later');
			result.current.skipCurrentDocument(session.id);
		});
		await waitFor(() => {
			expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
				errorPaused: false,
				error: undefined,
			});
		});
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Skipping document after error',
			session.id,
			{}
		);

		act(() => {
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Abort task');
			result.current.abortBatchOnError(session.id);
		});
		await waitFor(() => {
			expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
				isStopping: true,
				errorPaused: false,
				error: undefined,
			});
		});
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run aborted due to error',
			session.id,
			{}
		);

		seedRunningState();
		act(() => {
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Stop after error');
			result.current.stopBatchRun(session.id);
		});
		await waitFor(() => {
			expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
				isStopping: true,
				errorPaused: false,
				error: undefined,
			});
		});
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({ isStopping: true })
		);

		seedRunningState();
		act(() => {
			result.current.stopBatchRun(session.id);
		});
		await waitFor(() => {
			expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
				isStopping: true,
			});
		});
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenCalledWith(
			session.id,
			expect.objectContaining({ isStopping: true })
		);

		seedRunningState();
		await act(async () => {
			await result.current.killBatchRun(session.id);
		});
		expect(window.maestro.process.kill).toHaveBeenCalledWith(session.id);
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			processingState: 'IDLE',
			sessionIds: [],
		});
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenLastCalledWith(session.id, null);
		expect(window.maestro.power.removeReason).toHaveBeenCalledWith(`autorun:${session.id}`);

		seedRunningState();
		vi.mocked(window.maestro.process.kill).mockRejectedValueOnce(new Error('kill failed'));
		await act(async () => {
			await result.current.killBatchRun(session.id);
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[BatchProcessor:killBatchRun] Failed to kill process:',
			undefined,
			expect.any(Error)
		);
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			processingState: 'IDLE',
		});
	});

	it('handles error-resolution controls without batch state or pending pauses', () => {
		const session = createSession();
		useSessionStore.setState({ sessions: [session] });
		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent: vi.fn().mockResolvedValue({ success: true }),
				onAddHistoryEntry: vi.fn(),
				onComplete: vi.fn(),
			})
		);
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'No batch state exists',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 654,
			raw: { stderr: 'missing state' },
		};

		act(() => {
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Missing state');
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Existing pause');
			result.current.skipCurrentDocument(session.id);
			result.current.skipCurrentDocument(session.id);
			result.current.resumeAfterError(session.id);
			result.current.abortBatchOnError(session.id);
		});

		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			isStopping: true,
			processingState: 'IDLE',
		});
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run paused due to agent_crashed: No batch state exists',
			session.id,
			expect.objectContaining({ taskDescription: 'Missing state' })
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Skipping document after error',
			session.id,
			{}
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Resuming Auto Run after error resolution',
			session.id,
			{}
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run aborted due to error',
			session.id,
			{}
		);
	});

	it('cleans pending error pauses on unmount and ignores guarded controls afterward', async () => {
		const session = createSession();
		useSessionStore.setState({ sessions: [session] });
		const { result, unmount } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent: vi.fn().mockResolvedValue({ success: true }),
				onAddHistoryEntry: vi.fn(),
				onComplete: vi.fn(),
			})
		);
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Agent crashed after unmount test',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 789,
			raw: { stderr: 'crash' },
		};

		act(() => {
			useBatchStore.getState().setBatchRunStates({
				[session.id]: createRunningBatchState(),
			});
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Unmount cleanup');
		});
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			errorPaused: true,
			error: agentError,
		});

		unmount();
		vi.mocked(window.maestro.logger.autorun).mockClear();
		vi.mocked(window.maestro.web.broadcastAutoRunState).mockClear();

		act(() => {
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Ignored pause');
			result.current.skipCurrentDocument(session.id);
			result.current.resumeAfterError(session.id);
			result.current.abortBatchOnError(session.id);
		});

		expect(window.maestro.logger.autorun).not.toHaveBeenCalled();
		expect(window.maestro.web.broadcastAutoRunState).not.toHaveBeenCalled();
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			errorPaused: true,
			error: agentError,
		});
	});

	it('continues when stats startup and reset working-copy setup fail', async () => {
		const docs = new Map<string, string>([['reset-fallback.md', '- [ ] Finish fallback task']]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			docs.set('reset-fallback.md', '- [x] Finish fallback task');
			return {
				success: true,
				agentSessionId: 'claude-reset-fallback-1',
				response: '**Summary:** Finished fallback task.',
			};
		});

		vi.mocked(window.maestro.stats.startAutoRun).mockRejectedValueOnce(new Error('stats offline'));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockRejectedValueOnce(
			new Error('copy failed')
		);
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('reset-fallback', { resetOnCompletion: true })],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[BatchProcessor] Failed to start stats tracking:',
			undefined,
			expect.any(Error)
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'[BatchProcessor] Failed to create working copy for reset-fallback:',
			undefined,
			expect.any(Error)
		);
		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(window.maestro.stats.endAutoRun).not.toHaveBeenCalled();
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Finished fallback task.',
				success: true,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 1,
				wasStopped: false,
			})
		);
	});

	it('continues after an unpaused task exception leaves a reset document unfinished', async () => {
		const docs = new Map<string, string>([['reset-error.md', '- [ ] Fail without pause']]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockRejectedValue(new Error('agent failed before pause'));

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('reset-error', { resetOnCompletion: true })],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			`[BatchProcessor] Error running task in reset-error for session ${session.id}:`,
			undefined,
			expect.any(Error)
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 0,
				totalTasks: 1,
				wasStopped: false,
			})
		);
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			processingState: 'IDLE',
		});
	});

	it('skips an errored document from inside the task failure pause and processes the next document', async () => {
		const docs = new Map<string, string>([
			['error-doc.md', '- [ ] Fail this task'],
			['next-doc.md', '- [ ] Complete this task'],
		]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Agent crashed while processing a document',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 987,
			raw: { stderr: 'crash' },
		};
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt: string) => {
			if (prompt.includes('error-doc')) {
				resultRef!.current.pauseBatchOnError(session.id, agentError, 0, 'Fail this task');
				setTimeout(() => {
					resultRef!.current.skipCurrentDocument(session.id);
				}, 0);
				throw new Error('agent crashed');
			}

			docs.set('next-doc.md', '- [x] Complete this task');
			return {
				success: true,
				agentSessionId: 'claude-skip-next-1',
				response: '**Summary:** Completed the next document.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('error-doc'), createDocument('next-doc')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(2);
		expect(onSpawnAgent).toHaveBeenLastCalledWith(session.id, 'Process next-doc', undefined);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Skipping document after error',
			session.id,
			{}
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 2,
				wasStopped: false,
			})
		);
	});

	it('aborts the run from inside the task failure pause', async () => {
		const docs = new Map<string, string>([['abort-doc.md', '- [ ] Abort this task']]);
		const session = createSession();
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const agentError: AgentError = {
			type: 'token_exhaustion',
			message: 'Context limit reached',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 654,
			raw: { stderr: 'context limit' },
		};
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			resultRef!.current.pauseBatchOnError(session.id, agentError, 0, 'Abort this task');
			setTimeout(() => {
				resultRef!.current.abortBatchOnError(session.id);
			}, 0);
			throw new Error('context limit');
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('abort-doc')],
					prompt: 'Process aborting task',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run aborted due to error',
			session.id,
			{}
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 0,
				totalTasks: 1,
				wasStopped: true,
			})
		);
	});

	it('continues reset-only loop runs until the configured max loop count', async () => {
		const docs = new Map<string, string>([['repeat.md', '- [ ] Repeat task']]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			const loopNumber = onSpawnAgent.mock.calls.length;
			docs.set(`Runs/repeat-loop-${loopNumber}.md`, '- [x] Repeat task');
			return {
				success: true,
				agentSessionId: `claude-repeat-${loopNumber}`,
				response: `**Summary:** Completed repeat loop ${loopNumber}.`,
				usageStats: {
					inputTokens: 2,
					outputTokens: 3,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0.01,
					contextWindow: 200000,
				},
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('repeat', { resetOnCompletion: true })],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 2,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(2);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 1 completed: 1 task accomplished',
				fullResponse: expect.stringContaining('- **Tasks Discovered for Next Loop:** 1'),
				success: true,
			})
		);
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Loop 1 completed',
			session.name,
			expect.objectContaining({
				loopNumber: 1,
				tasksCompleted: 1,
				tasksForNextLoop: 1,
			})
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 2 (final) completed: 1 task accomplished',
				success: true,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 2,
				totalTasks: 1,
				wasStopped: false,
			})
		);
	});

	it('resolves a pre-task error pause by skipping the paused document', async () => {
		const docs = new Map<string, string>([
			['paused-first.md', '- [ ] Skip this task'],
			['paused-next.md', '- [ ] Complete next task'],
		]);
		const session = createSession();
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Paused before task processing',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 753,
			raw: { stderr: 'paused' },
		};
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt: string) => {
			docs.set('paused-next.md', '- [x] Complete next task');
			return {
				success: true,
				agentSessionId: 'claude-pre-skip-1',
				response: `**Summary:** ${prompt} completed.`,
			};
		});

		vi.mocked(window.maestro.stats.startAutoRun).mockImplementationOnce(async () => {
			resultRef!.current.pauseBatchOnError(session.id, agentError, 0, 'Skip this task');
			setTimeout(() => {
				resultRef!.current.skipCurrentDocument(session.id);
			}, 0);
			return 'auto-run-pre-skip';
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('paused-first'), createDocument('paused-next')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(onSpawnAgent).toHaveBeenCalledWith(session.id, 'Process paused-next', undefined);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 2,
				wasStopped: false,
			})
		);
	});

	it('resolves a pre-task error pause by resuming the paused document', async () => {
		const docs = new Map<string, string>([['paused-resume.md', '- [ ] Resume this task']]);
		const session = createSession();
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Paused before resume',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 754,
			raw: { stderr: 'paused' },
		};
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			docs.set('paused-resume.md', '- [x] Resume this task');
			return {
				success: true,
				agentSessionId: 'claude-pre-resume-1',
				response: '**Summary:** Resumed and completed the task.',
			};
		});

		vi.mocked(window.maestro.stats.startAutoRun).mockImplementationOnce(async () => {
			resultRef!.current.pauseBatchOnError(session.id, agentError, 0, 'Resume this task');
			setTimeout(() => {
				resultRef!.current.resumeAfterError(session.id);
			}, 0);
			return 'auto-run-pre-resume';
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('paused-resume')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(onSpawnAgent).toHaveBeenCalledWith(session.id, 'Process paused-resume', undefined);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 1,
				wasStopped: false,
			})
		);
	});

	it('resolves a pre-task error pause by aborting before the agent starts', async () => {
		const docs = new Map<string, string>([['paused-abort.md', '- [ ] Abort before task']]);
		const session = createSession();
		const onSpawnAgent = vi.fn().mockResolvedValue({ success: true });
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const agentError: AgentError = {
			type: 'token_exhaustion',
			message: 'Context limit reached before task',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 852,
			raw: { stderr: 'context limit' },
		};

		vi.mocked(window.maestro.stats.startAutoRun).mockImplementationOnce(async () => {
			resultRef!.current.pauseBatchOnError(session.id, agentError, 0, 'Abort before task');
			setTimeout(() => {
				resultRef!.current.abortBatchOnError(session.id);
			}, 0);
			return 'auto-run-pre-abort';
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('paused-abort')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).not.toHaveBeenCalled();
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 0,
				totalTasks: 1,
				wasStopped: true,
			})
		);
	});

	it('honors stop requests before loop and before the next document', async () => {
		const loopStoppedDocs = new Map<string, string>([
			['loop-stop.md', '- [ ] Never start this task'],
		]);
		const nextDocumentDocs = new Map<string, string>([
			['stop-first.md', '- [ ] Complete then stop'],
			['stop-second.md', '- [ ] Should not run'],
		]);
		const session = createSession();
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: loopStoppedDocs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.stats.startAutoRun).mockImplementationOnce(async () => {
			resultRef!.current.stopBatchRun(session.id);
			return 'auto-run-loop-stop';
		});
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent: vi.fn(),
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('loop-stop')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onComplete).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 0,
				totalTasks: 1,
				wasStopped: true,
			})
		);

		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			nextDocumentDocs.set('stop-first.md', '- [x] Complete then stop');
			resultRef!.current.stopBatchRun(session.id);
			return {
				success: true,
				agentSessionId: 'claude-stop-current-1',
				response: '**Summary:** Completed and requested stop.',
			};
		});
		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: nextDocumentDocs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.stats.startAutoRun).mockResolvedValueOnce(
			'auto-run-before-next-document'
		);

		const secondHook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);
		resultRef = secondHook.result;

		await act(async () => {
			await secondHook.result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('stop-first'), createDocument('stop-second')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(onSpawnAgent).toHaveBeenCalledWith(session.id, 'Process stop-first', undefined);
		expect(onComplete).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				totalTasks: 2,
				wasStopped: true,
			})
		);
	});

	it('resolves a pending error pause when force-killing a batch run', async () => {
		const session = createSession();
		useSessionStore.setState({ sessions: [session] });
		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent: vi.fn().mockResolvedValue({ success: true }),
				onAddHistoryEntry: vi.fn(),
				onComplete: vi.fn(),
			})
		);
		const agentError: AgentError = {
			type: 'agent_crashed',
			message: 'Kill paused batch',
			recoverable: true,
			agentId: 'claude-code',
			sessionId: session.id,
			timestamp: 951,
			raw: { stderr: 'crash' },
		};

		act(() => {
			useBatchStore.getState().setBatchRunStates({
				[session.id]: createRunningBatchState(),
			});
			result.current.pauseBatchOnError(session.id, agentError, 0, 'Kill paused task');
		});

		await act(async () => {
			await result.current.killBatchRun(session.id);
		});

		expect(window.maestro.process.kill).toHaveBeenCalledWith(session.id);
		expect(window.maestro.web.broadcastAutoRunState).toHaveBeenLastCalledWith(session.id, null);
		expect(useBatchStore.getState().batchRunStates[session.id]).toMatchObject({
			isRunning: false,
			processingState: 'IDLE',
		});
	});

	it('ends loop mode when non-reset documents have no remaining work', async () => {
		const docs = new Map<string, string>([
			['reset-plus.md', '- [ ] Repeatable reset task'],
			['plain-plus.md', '- [ ] Finish plain task'],
		]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt: string) => {
			if (prompt.includes('reset-plus')) {
				docs.set('Runs/reset-plus-loop-1.md', '- [x] Repeatable reset task');
			} else {
				docs.set('plain-plus.md', '- [x] Finish plain task');
			}

			return {
				success: true,
				agentSessionId: `claude-loop-exit-${onSpawnAgent.mock.calls.length}`,
				response: '**Summary:** Completed loop exit task.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [
						createDocument('reset-plus', { resetOnCompletion: true }),
						createDocument('plain-plus'),
					],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 3,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(2);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 1 (final) completed: 2 tasks accomplished',
				fullResponse: expect.stringContaining('- **Exit Reason:** All tasks completed'),
				success: true,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 2,
				totalTasks: 2,
				wasStopped: false,
			})
		);
	});

	it('honors stop requests raised after reset document cleanup before opening the next document', async () => {
		const docs = new Map<string, string>([
			['reset-stop.md', '- [ ] Reset then stop'],
			['stop-next.md', '- [ ] Should not run'],
		]);
		const session = createSession();
		const onComplete = vi.fn();
		let resultRef: { current: ReturnType<typeof useBatchProcessor> } | null = null;
		const onAddHistoryEntry = vi.fn().mockImplementation((entry) => {
			if (String(entry.summary).includes('Completed reset task')) {
				queueMicrotask(() => resultRef!.current.stopBatchRun(session.id));
			}
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			docs.set('Runs/reset-stop-loop-1.md', '- [x] Reset then stop');
			return {
				success: true,
				agentSessionId: 'claude-stop-after-reset',
				response: '**Summary:** Completed reset task before stopping.',
			};
		});
		useSessionStore.setState({ sessions: [session] });

		const hook = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);
		resultRef = hook.result;

		await act(async () => {
			await hook.result.current.startBatchRun(
				session.id,
				{
					documents: [
						createDocument('reset-stop', { resetOnCompletion: true }),
						createDocument('stop-next'),
					],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 2,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(1);
		expect(onSpawnAgent).toHaveBeenCalledWith(
			session.id,
			'Process Runs/reset-stop-loop-1',
			undefined
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 1,
				wasStopped: true,
			})
		);
	});

	it('continues loop mode when a non-reset document still has unchecked work after a pass', async () => {
		const docs = new Map<string, string>([
			['reset-repeat.md', '- [ ] Repeat reset task'],
			['plain-stalled.md', '- [ ] Still needs manual follow-up'],
		]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt: string) => {
			if (prompt.includes('reset-repeat')) {
				const loopNumber = prompt.includes('loop-2') ? 2 : 1;
				docs.set(`Runs/reset-repeat-loop-${loopNumber}.md`, '- [x] Repeat reset task');
			}

			return {
				success: true,
				agentSessionId: `claude-loop-continue-${onSpawnAgent.mock.calls.length}`,
				response: '**Summary:** Processed loop continuation task.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [
						createDocument('reset-repeat', { resetOnCompletion: true }),
						createDocument('plain-stalled'),
					],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 2,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledWith(
			session.id,
			'Process Runs/reset-repeat-loop-1',
			undefined
		);
		expect(onSpawnAgent).toHaveBeenCalledWith(
			session.id,
			'Process Runs/reset-repeat-loop-2',
			undefined
		);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 1 completed: 1 task accomplished',
				fullResponse: expect.stringContaining('- **Tasks Discovered for Next Loop:** 2'),
				success: true,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 2,
				wasStopped: false,
			})
		);
	});

	it('records plural non-final loop summaries for reset-only passes', async () => {
		const docs = new Map<string, string>([
			['reset-plural.md', '- [ ] First reset task\n- [ ] Second reset task'],
		]);
		const session = createSession();
		const onAddHistoryEntry = vi.fn().mockResolvedValue(undefined);
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async (_sessionId, prompt: string) => {
			const loopNumber = prompt.includes('loop-2') ? 2 : 1;
			docs.set(
				`Runs/reset-plural-loop-${loopNumber}.md`,
				'- [x] First reset task\n- [x] Second reset task'
			);
			return {
				success: true,
				agentSessionId: `claude-reset-plural-${loopNumber}`,
				response: '**Summary:** Completed both reset tasks.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		vi.mocked(window.maestro.autorun.createWorkingCopy).mockImplementation(
			async (_folder, filename, loopIteration) => {
				const workingCopyPath = `Runs/${filename}-loop-${loopIteration}`;
				docs.set(`${workingCopyPath}.md`, docs.get(`${filename}.md`) ?? '');
				return { workingCopyPath };
			}
		);
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry,
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('reset-plural', { resetOnCompletion: true })],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 2,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(2);
		expect(onAddHistoryEntry).toHaveBeenCalledWith(
			expect.objectContaining({
				summary: 'Loop 1 completed: 2 tasks accomplished',
				fullResponse: expect.stringContaining('- **Tasks Accomplished:** 2'),
				success: true,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 4,
				wasStopped: false,
			})
		);
	});

	it('accounts for tasks that add unchecked follow-up work during processing', async () => {
		const docs = new Map<string, string>([['expand.md', '- [ ] Seed task']]);
		const session = createSession();
		const onComplete = vi.fn();
		const onSpawnAgent = vi.fn().mockImplementation(async () => {
			if (onSpawnAgent.mock.calls.length === 1) {
				setDocumentHidden(true);
				document.dispatchEvent(new Event('visibilitychange'));
				setDocumentHidden(false);
				document.dispatchEvent(new Event('visibilitychange'));
				docs.set('expand.md', '- [x] Seed task\n- [ ] Follow-up A\n- [ ] Follow-up B');
			} else {
				docs.set('expand.md', '- [x] Seed task\n- [x] Follow-up A\n- [x] Follow-up B');
			}

			return {
				success: true,
				agentSessionId: `claude-expand-${onSpawnAgent.mock.calls.length}`,
				response: '**Summary:** Updated expanding document.',
			};
		});

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async (_folder, filename) => ({
			success: true,
			content: docs.get(filename) ?? '',
		}));
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('expand')],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: false,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).toHaveBeenCalledTimes(2);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 3,
				wasStopped: false,
			})
		);
	});

	it('exits loop mode when no tasks are processed in a reset document pass', async () => {
		const session = createSession();
		const onSpawnAgent = vi.fn().mockResolvedValue({ success: true });
		const onComplete = vi.fn();
		let readCount = 0;

		vi.mocked(window.maestro.autorun.readDoc).mockImplementation(async () => {
			readCount++;
			return {
				success: true,
				content: readCount === 1 ? '- [ ] Race task' : '- [x] Race task',
			};
		});
		useSessionStore.setState({ sessions: [session] });

		const { result } = renderHook(() =>
			useBatchProcessor({
				sessions: [session],
				groups: [],
				onUpdateSession: vi.fn(),
				onSpawnAgent,
				onAddHistoryEntry: vi.fn(),
				onComplete,
			})
		);

		await act(async () => {
			await result.current.startBatchRun(
				session.id,
				{
					documents: [createDocument('race-reset', { resetOnCompletion: true })],
					prompt: 'Process {{DOCUMENT_NAME}}',
					loopEnabled: true,
					maxLoops: 2,
				},
				'/repo/main/.maestro/auto-run'
			);
		});

		expect(onSpawnAgent).not.toHaveBeenCalled();
		expect(window.maestro.logger.autorun).toHaveBeenCalledWith(
			'Auto Run exiting: No tasks processed this iteration',
			session.name,
			expect.objectContaining({
				reason: 'No tasks processed this iteration',
				totalTasksCompleted: 0,
			})
		);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: session.id,
				completedTasks: 0,
				totalTasks: 1,
				wasStopped: false,
			})
		);
	});
});
