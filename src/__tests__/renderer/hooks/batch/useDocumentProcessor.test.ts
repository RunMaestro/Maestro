import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentProcessor } from '../../../../renderer/hooks/batch/useDocumentProcessor';
import type {
	DocumentProcessorCallbacks,
	DocumentProcessorConfig,
	TaskResult,
} from '../../../../renderer/hooks/batch/useDocumentProcessor';
import type { Session } from '../../../../renderer/types';

const createSession = (overrides: Partial<Session> = {}): Session =>
	({
		id: 'session-1',
		name: 'Docs Agent',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/workspace/main',
		fullPath: '/workspace/main',
		projectRoot: '/workspace/main',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: true,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		...overrides,
	}) as Session;

const createConfig = (
	overrides: Partial<DocumentProcessorConfig> = {}
): DocumentProcessorConfig => ({
	folderPath: '/auto-run',
	session: createSession(),
	gitBranch: 'feature/docs',
	groupName: 'Docs Group',
	loopIteration: 3,
	effectiveCwd: '/workspace/worktree',
	customPrompt: 'Process {{DOCUMENT_NAME}} on {{GIT_BRANCH}} in {{SESSION_NAME}}',
	sshRemoteId: 'remote-1',
	...overrides,
});

const createCallbacks = (
	spawnResult: Awaited<ReturnType<DocumentProcessorCallbacks['onSpawnAgent']>>
): DocumentProcessorCallbacks => ({
	onSpawnAgent: vi.fn().mockResolvedValue(spawnResult),
});

const readDoc = () => vi.mocked(window.maestro.autorun.readDoc);
const writeDoc = () => vi.mocked(window.maestro.autorun.writeDoc);
const registerSessionOrigin = () => vi.mocked(window.maestro.agentSessions.registerSessionOrigin);

describe('useDocumentProcessor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		readDoc().mockResolvedValue({ success: true, content: '' });
		writeDoc().mockResolvedValue({ success: true });
		registerSessionOrigin().mockResolvedValue(undefined);
	});

	describe('readDocAndCountTasks', () => {
		it('reads document content and counts checked and unchecked tasks', async () => {
			readDoc().mockResolvedValueOnce({
				success: true,
				content: '# Plan\n- [ ] Build tests\n- [x] Ship docs\n- [ ] Update audit',
			});
			const { result } = renderHook(() => useDocumentProcessor());

			let readResult: Awaited<ReturnType<typeof result.current.readDocAndCountTasks>>;
			await act(async () => {
				readResult = await result.current.readDocAndCountTasks('/docs', 'phase-1', 'ssh-1');
			});

			expect(readDoc()).toHaveBeenCalledWith('/docs', 'phase-1.md', 'ssh-1');
			expect(readResult!).toEqual({
				content: '# Plan\n- [ ] Build tests\n- [x] Ship docs\n- [ ] Update audit',
				taskCount: 2,
				checkedCount: 1,
			});
		});

		it('returns empty counts when document reads fail or contain no content', async () => {
			readDoc()
				.mockResolvedValueOnce({ success: false })
				.mockResolvedValueOnce({ success: true, content: '' });
			const { result } = renderHook(() => useDocumentProcessor());

			let failedRead: Awaited<ReturnType<typeof result.current.readDocAndCountTasks>>;
			let emptyRead: Awaited<ReturnType<typeof result.current.readDocAndCountTasks>>;
			await act(async () => {
				failedRead = await result.current.readDocAndCountTasks('/docs', 'missing');
				emptyRead = await result.current.readDocAndCountTasks('/docs', 'empty');
			});

			expect(failedRead!).toEqual({ content: '', taskCount: 0, checkedCount: 0 });
			expect(emptyRead!).toEqual({ content: '', taskCount: 0, checkedCount: 0 });
		});
	});

	describe('processTask', () => {
		it('expands document variables, registers the spawned agent, and truncates long summaries', async () => {
			const longSummary = 'a'.repeat(151);
			readDoc()
				.mockResolvedValueOnce({
					success: true,
					content: '# {{SESSION_NAME}}\n- [ ] Build tests',
				})
				.mockResolvedValueOnce({
					success: true,
					content: '# Docs Agent\n- [x] Build tests\n- [ ] Update audit',
				});
			const callbacks = createCallbacks({
				success: true,
				response: `**Summary:** ${longSummary}\n\nDetailed notes`,
				agentSessionId: 'agent-session-1',
				usageStats: {
					inputTokens: 10,
					outputTokens: 5,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: 0,
				},
			});
			const { result } = renderHook(() => useDocumentProcessor());

			let taskResult: TaskResult;
			await act(async () => {
				taskResult = await result.current.processTask(
					createConfig(),
					'phase-1',
					0,
					1,
					'# {{SESSION_NAME}}\n- [ ] Build tests',
					callbacks
				);
			});

			expect(writeDoc()).toHaveBeenCalledWith(
				'/auto-run',
				'phase-1.md',
				'# Docs Agent\n- [ ] Build tests',
				'remote-1'
			);
			expect(callbacks.onSpawnAgent).toHaveBeenCalledWith(
				'session-1',
				'Process phase-1 on feature/docs in Docs Agent',
				'/workspace/worktree'
			);
			expect(registerSessionOrigin()).toHaveBeenCalledWith(
				'/workspace/worktree',
				'agent-session-1',
				'auto'
			);
			expect(taskResult!.shortSummary).toBe(`${'a'.repeat(150)}...`);
			expect(taskResult!.fullSynopsis).toBe(`**Summary:** ${longSummary}\n\nDetailed notes`);
			expect(taskResult!.tasksCompletedThisRun).toBe(1);
			expect(taskResult!.newRemainingTasks).toBe(1);
			expect(taskResult!.newCheckedCount).toBe(1);
			expect(taskResult!.documentChanged).toBe(true);
			expect(taskResult!.addedUncheckedTasks).toBe(0);
			expect(taskResult!.totalTasksChange).toBe(1);
		});

		it('skips write-back for unchanged content and omits cwd override when using the session cwd', async () => {
			readDoc()
				.mockResolvedValueOnce({
					success: true,
					content: '# Plan\n- [ ] Build tests',
				})
				.mockResolvedValueOnce({
					success: true,
					content: '# Plan\n- [x] Build tests',
				});
			const session = createSession({ cwd: '/workspace/main' });
			const callbacks = createCallbacks({
				success: true,
				response: 'Implemented the first task. More details follow.',
			});
			const { result } = renderHook(() => useDocumentProcessor());

			let taskResult: TaskResult;
			await act(async () => {
				taskResult = await result.current.processTask(
					createConfig({ session, effectiveCwd: '/workspace/main', sshRemoteId: undefined }),
					'phase-1',
					0,
					1,
					'# Plan\n- [ ] Build tests',
					callbacks
				);
			});

			expect(writeDoc()).not.toHaveBeenCalled();
			expect(callbacks.onSpawnAgent).toHaveBeenCalledWith(
				'session-1',
				'Process phase-1 on feature/docs in Docs Agent',
				undefined
			);
			expect(registerSessionOrigin()).not.toHaveBeenCalled();
			expect(taskResult!.shortSummary).toBe('Implemented the first task.');
			expect(taskResult!.fullSynopsis).toBe('Implemented the first task. More details follow.');
		});

		it('keeps the default completion summary for blank successful responses', async () => {
			readDoc()
				.mockResolvedValueOnce({ success: false })
				.mockResolvedValueOnce({ success: true, content: '- [ ] Still open' });
			const callbacks = createCallbacks({ success: true, response: '   ' });
			const { result } = renderHook(() => useDocumentProcessor());

			let taskResult: TaskResult;
			await act(async () => {
				taskResult = await result.current.processTask(
					createConfig(),
					'phase-empty',
					0,
					1,
					'- [ ] Still open',
					callbacks
				);
			});

			expect(writeDoc()).not.toHaveBeenCalled();
			expect(taskResult!.shortSummary).toBe('[phase-empty] Task completed');
			expect(taskResult!.fullSynopsis).toBe('[phase-empty] Task completed');
		});

		it('keeps the default completion summary for cleaned empty or too-short responses', async () => {
			const { result } = renderHook(() => useDocumentProcessor());

			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			const headingOnlyCallbacks = createCallbacks({ success: true, response: '###' });
			let headingOnlyResult: TaskResult;
			await act(async () => {
				headingOnlyResult = await result.current.processTask(
					createConfig(),
					'heading-only',
					0,
					0,
					'# Plan',
					headingOnlyCallbacks
				);
			});

			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			const shortCallbacks = createCallbacks({ success: true, response: 'Short' });
			let shortResult: TaskResult;
			await act(async () => {
				shortResult = await result.current.processTask(
					createConfig(),
					'short-response',
					0,
					0,
					'# Plan',
					shortCallbacks
				);
			});

			expect(headingOnlyResult!.shortSummary).toBe('[heading-only] Task completed');
			expect(shortResult!.shortSummary).toBe('[short-response] Task completed');
		});

		it('uses the cleaned paragraph when no sentence boundary is present and no truncation is needed', async () => {
			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			const callbacks = createCallbacks({
				success: true,
				response: '**Summary:** Completed batch document processing without punctuation',
			});
			const { result } = renderHook(() => useDocumentProcessor());

			let taskResult: TaskResult;
			await act(async () => {
				taskResult = await result.current.processTask(
					createConfig(),
					'no-sentence-boundary',
					0,
					0,
					'# Plan',
					callbacks
				);
			});

			expect(taskResult!.shortSummary).toBe(
				'Completed batch document processing without punctuation'
			);
		});

		it('keeps the default completion summary when a successful spawn has no response', async () => {
			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			const callbacks = createCallbacks({ success: true });
			const { result } = renderHook(() => useDocumentProcessor());

			let taskResult: TaskResult;
			await act(async () => {
				taskResult = await result.current.processTask(
					createConfig(),
					'no-response',
					0,
					0,
					'# Plan',
					callbacks
				);
			});

			expect(taskResult!.shortSummary).toBe('[no-response] Task completed');
			expect(taskResult!.fullSynopsis).toBe('[no-response] Task completed');
		});

		it('logs session origin registration failures without failing the task', async () => {
			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			registerSessionOrigin().mockRejectedValueOnce(new Error('origin failed'));
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
			const callbacks = createCallbacks({
				success: true,
				response: 'Registered session origin. More details follow.',
				agentSessionId: 'agent-session-2',
			});
			const { result } = renderHook(() => useDocumentProcessor());

			let taskResult: TaskResult;
			try {
				await act(async () => {
					taskResult = await result.current.processTask(
						createConfig(),
						'register-failure',
						0,
						0,
						'# Plan',
						callbacks
					);
					await Promise.resolve();
				});

				expect(taskResult!.success).toBe(true);
				expect(consoleError).toHaveBeenCalledWith(
					'[DocumentProcessor] Failed to register session origin:',
					expect.any(Error)
				);
			} finally {
				consoleError.mockRestore();
			}
		});

		it('uses failure summaries with response and default fallback synopses', async () => {
			const { result } = renderHook(() => useDocumentProcessor());

			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			const failedWithResponseCallbacks = createCallbacks({
				success: false,
				response: 'Agent failed with details',
			});
			let failedWithResponse: TaskResult;
			await act(async () => {
				failedWithResponse = await result.current.processTask(
					createConfig(),
					'failed-response',
					0,
					0,
					'# Plan',
					failedWithResponseCallbacks
				);
			});

			readDoc()
				.mockResolvedValueOnce({ success: true, content: '# Plan' })
				.mockResolvedValueOnce({ success: true, content: '# Plan' });
			const failedWithoutResponseCallbacks = createCallbacks({ success: false });
			let failedWithoutResponse: TaskResult;
			await act(async () => {
				failedWithoutResponse = await result.current.processTask(
					createConfig(),
					'failed-default',
					0,
					0,
					'# Plan',
					failedWithoutResponseCallbacks
				);
			});

			expect(failedWithResponse!.shortSummary).toBe('[failed-response] Task failed');
			expect(failedWithResponse!.fullSynopsis).toBe('Agent failed with details');
			expect(failedWithoutResponse!.shortSummary).toBe('[failed-default] Task failed');
			expect(failedWithoutResponse!.fullSynopsis).toBe('[failed-default] Task failed');
		});
	});
});
