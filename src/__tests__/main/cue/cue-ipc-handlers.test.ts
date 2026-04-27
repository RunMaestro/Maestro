/**
 * Tests for Cue IPC handlers.
 *
 * Tests cover:
 * - Handler registration with ipcMain.handle
 * - Delegation to CueEngine methods (getStatus, getActiveRuns, etc.)
 * - YAML read/write/validate operations
 * - Engine enable/disable controls
 * - Error handling when engine is not initialized
 *
 * Phase 6 cleanup: the IPC handler is now a thin transport layer. YAML I/O
 * lives in cue-config-repository.ts and pipeline layout I/O lives in
 * pipeline-layout-store.ts. These tests mock those modules directly to verify
 * the handlers correctly delegate, rather than mocking fs/path under the hood.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track registered IPC handlers
const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('js-yaml', () => ({
	load: vi.fn(),
}));

vi.mock('../../../main/utils/ipcHandler', () => ({
	withIpcErrorLogging: vi.fn(
		(
			_opts: unknown,
			handler: (...args: unknown[]) => unknown
		): ((_event: unknown, ...args: unknown[]) => unknown) => {
			return (_event: unknown, ...args: unknown[]) => handler(...args);
		}
	),
}));

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	validateCueConfig: vi.fn(),
	findAncestorCueConfigRoot: () => null,
	findAncestorCueConfigRoots: () => [],
}));

vi.mock('../../../main/cue/config/cue-config-repository', () => ({
	readCueConfigFile: vi.fn(),
	writeCueConfigFile: vi.fn(),
	deleteCueConfigFile: vi.fn(),
	writeCuePromptFile: vi.fn(),
	pruneOrphanedPromptFiles: vi.fn(() => []),
	removeEmptyPromptsDir: vi.fn(() => false),
	removeEmptyMaestroDir: vi.fn(() => false),
}));

vi.mock('../../../main/cue/pipeline-layout-store', () => ({
	savePipelineLayout: vi.fn(),
	loadPipelineLayout: vi.fn(),
}));

vi.mock('../../../main/cue/cue-types', () => ({
	CUE_YAML_FILENAME: 'maestro-cue.yaml', // legacy name kept in cue-types for compat
}));

import { registerCueHandlers } from '../../../main/ipc/handlers/cue';
import { validateCueConfig } from '../../../main/cue/cue-yaml-loader';
import {
	readCueConfigFile,
	writeCueConfigFile,
	deleteCueConfigFile,
	writeCuePromptFile,
	pruneOrphanedPromptFiles,
	removeEmptyPromptsDir,
	removeEmptyMaestroDir,
} from '../../../main/cue/config/cue-config-repository';
import { savePipelineLayout, loadPipelineLayout } from '../../../main/cue/pipeline-layout-store';
import * as yaml from 'js-yaml';

// Create a mock CueEngine
function createMockEngine() {
	return {
		getSettings: vi.fn().mockReturnValue({
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		}),
		getStatus: vi.fn().mockReturnValue([]),
		getActiveRuns: vi.fn().mockReturnValue([]),
		getActivityLog: vi.fn().mockReturnValue([]),
		start: vi.fn(),
		stop: vi.fn(),
		stopRun: vi.fn().mockReturnValue(true),
		stopAll: vi.fn(),
		triggerSubscription: vi.fn().mockReturnValue(true),
		getQueueStatus: vi.fn().mockReturnValue(new Map()),
		refreshSession: vi.fn(),
		removeSession: vi.fn(),
		getGraphData: vi.fn().mockReturnValue([]),
		isEnabled: vi.fn().mockReturnValue(false),
	};
}

describe('Cue IPC Handlers', () => {
	let mockEngine: ReturnType<typeof createMockEngine>;

	beforeEach(() => {
		registeredHandlers.clear();
		vi.clearAllMocks();
		mockEngine = createMockEngine();
	});

	afterEach(() => {
		registeredHandlers.clear();
	});

	function registerAndGetHandler(channel: string) {
		registerCueHandlers({
			getCueEngine: () => mockEngine as any,
		});
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`Handler for channel "${channel}" not registered`);
		}
		return handler;
	}

	describe('handler registration', () => {
		it('should register all expected IPC channels', () => {
			registerCueHandlers({
				getCueEngine: () => mockEngine as any,
			});

			const expectedChannels = [
				'cue:getSettings',
				'cue:getStatus',
				'cue:getActiveRuns',
				'cue:getActivityLog',
				'cue:enable',
				'cue:disable',
				'cue:stopRun',
				'cue:stopAll',
				'cue:triggerSubscription',
				'cue:getQueueStatus',
				'cue:refreshSession',
				'cue:removeSession',
				'cue:getGraphData',
				'cue:readYaml',
				'cue:writeYaml',
				'cue:deleteYaml',
				'cue:validateYaml',
				'cue:savePipelineLayout',
				'cue:loadPipelineLayout',
			];

			for (const channel of expectedChannels) {
				expect(registeredHandlers.has(channel)).toBe(true);
			}
		});
	});

	describe('engine not initialized', () => {
		it('should throw when engine is null', async () => {
			registerCueHandlers({
				getCueEngine: () => null,
			});

			const handler = registeredHandlers.get('cue:getStatus')!;
			await expect(handler(null)).rejects.toThrow('Cue engine not initialized');
		});
	});

	describe('cue:getStatus', () => {
		it('should delegate to engine.getStatus()', async () => {
			const mockStatus = [
				{
					sessionId: 's1',
					sessionName: 'Test',
					toolType: 'claude-code',
					enabled: true,
					subscriptionCount: 2,
					activeRuns: 0,
				},
			];
			mockEngine.getStatus.mockReturnValue(mockStatus);

			const handler = registerAndGetHandler('cue:getStatus');
			const result = await handler(null);
			expect(result).toEqual(mockStatus);
			expect(mockEngine.getStatus).toHaveBeenCalledOnce();
		});
	});

	describe('cue:getActiveRuns', () => {
		it('should delegate to engine.getActiveRuns()', async () => {
			const mockRuns = [{ runId: 'r1', status: 'running' }];
			mockEngine.getActiveRuns.mockReturnValue(mockRuns);

			const handler = registerAndGetHandler('cue:getActiveRuns');
			const result = await handler(null);
			expect(result).toEqual(mockRuns);
			expect(mockEngine.getActiveRuns).toHaveBeenCalledOnce();
		});
	});

	describe('cue:getActivityLog', () => {
		it('should delegate to engine.getActivityLog() with limit', async () => {
			const mockLog = [{ runId: 'r1', status: 'completed' }];
			mockEngine.getActivityLog.mockReturnValue(mockLog);

			const handler = registerAndGetHandler('cue:getActivityLog');
			const result = await handler(null, { limit: 10 });
			expect(result).toEqual(mockLog);
			expect(mockEngine.getActivityLog).toHaveBeenCalledWith(10);
		});

		it('should pass undefined limit when not provided', async () => {
			const handler = registerAndGetHandler('cue:getActivityLog');
			await handler(null, {});
			expect(mockEngine.getActivityLog).toHaveBeenCalledWith(undefined);
		});
	});

	describe('cue:enable', () => {
		it('should call engine.start() with system-boot reason', async () => {
			const handler = registerAndGetHandler('cue:enable');
			await handler(null);
			expect(mockEngine.start).toHaveBeenCalledWith('system-boot');
		});
	});

	describe('cue:disable', () => {
		it('should call engine.stop()', async () => {
			const handler = registerAndGetHandler('cue:disable');
			await handler(null);
			expect(mockEngine.stop).toHaveBeenCalledOnce();
		});
	});

	describe('cue:removeSession', () => {
		it('should call engine.removeSession()', async () => {
			const handler = registerAndGetHandler('cue:removeSession');
			await handler(null, { sessionId: 's1' });
			expect(mockEngine.removeSession).toHaveBeenCalledWith('s1');
		});
	});

	describe('cue:stopRun', () => {
		it('should delegate to engine.stopRun() with runId', async () => {
			mockEngine.stopRun.mockReturnValue(true);
			const handler = registerAndGetHandler('cue:stopRun');
			const result = await handler(null, { runId: 'run-123' });
			expect(result).toBe(true);
			expect(mockEngine.stopRun).toHaveBeenCalledWith('run-123');
		});

		it('should return false when run not found', async () => {
			mockEngine.stopRun.mockReturnValue(false);
			const handler = registerAndGetHandler('cue:stopRun');
			const result = await handler(null, { runId: 'nonexistent' });
			expect(result).toBe(false);
		});
	});

	describe('cue:stopAll', () => {
		it('should call engine.stopAll()', async () => {
			const handler = registerAndGetHandler('cue:stopAll');
			await handler(null);
			expect(mockEngine.stopAll).toHaveBeenCalledOnce();
		});
	});

	describe('cue:refreshSession', () => {
		it('should delegate to engine.refreshSession()', async () => {
			const handler = registerAndGetHandler('cue:refreshSession');
			await handler(null, { sessionId: 's1', projectRoot: '/projects/test' });
			expect(mockEngine.refreshSession).toHaveBeenCalledWith('s1', '/projects/test');
		});
	});

	describe('cue:readYaml', () => {
		it('should return file content when file exists', async () => {
			vi.mocked(readCueConfigFile).mockReturnValue({
				filePath: '/projects/test/.maestro/cue.yaml',
				raw: 'subscriptions: []',
			});

			const handler = registerAndGetHandler('cue:readYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe('subscriptions: []');
			expect(readCueConfigFile).toHaveBeenCalledWith('/projects/test');
		});

		it('should return null when file does not exist', async () => {
			vi.mocked(readCueConfigFile).mockReturnValue(null);

			const handler = registerAndGetHandler('cue:readYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBeNull();
		});
	});

	describe('cue:writeYaml', () => {
		it('should delegate to writeCueConfigFile', async () => {
			const content = 'subscriptions:\n  - name: test\n    event: time.heartbeat';

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content });
			expect(writeCueConfigFile).toHaveBeenCalledWith('/projects/test', content);
		});

		it('adds fan_out_prompt_files entries to the prune keep-set', async () => {
			// Regression guard: without this, per-agent fan-out prompt files
			// would be deleted by pruneOrphanedPromptFiles on every save —
			// only `prompt_file` and `output_prompt_file` were kept.
			vi.mocked(yaml.load).mockReturnValue({
				subscriptions: [
					{
						name: 'fan-out',
						event: 'app.startup',
						fan_out: ['A', 'B', 'C'],
						fan_out_prompt_files: [
							'.maestro/prompts/a-pipe.md',
							'.maestro/prompts/b-pipe.md',
							'.maestro/prompts/c-pipe.md',
						],
					},
				],
			});

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content: 'ignored-by-mock' });

			expect(pruneOrphanedPromptFiles).toHaveBeenCalledTimes(1);
			const [, keepSet] = vi.mocked(pruneOrphanedPromptFiles).mock.calls[0];
			const kept = [...(keepSet as Iterable<string>)];
			expect(kept).toEqual(
				expect.arrayContaining([
					'.maestro/prompts/a-pipe.md',
					'.maestro/prompts/b-pipe.md',
					'.maestro/prompts/c-pipe.md',
				])
			);
		});

		it('should also write external prompt files when provided', async () => {
			const content = 'subscriptions: []';
			const promptFiles = {
				'.maestro/prompts/sub-1.md': 'prompt body 1',
				'.maestro/prompts/sub-2.md': 'prompt body 2',
			};

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content, promptFiles });

			expect(writeCueConfigFile).toHaveBeenCalledWith('/projects/test', content);
			expect(writeCuePromptFile).toHaveBeenCalledWith(
				'/projects/test',
				'.maestro/prompts/sub-1.md',
				'prompt body 1'
			);
			expect(writeCuePromptFile).toHaveBeenCalledWith(
				'/projects/test',
				'.maestro/prompts/sub-2.md',
				'prompt body 2'
			);
		});

		// Security-hardening tests: reject malformed prompt-file keys that
		// could write outside the .maestro/prompts/ directory. The handler
		// validates and throws synchronously from inside the async callback —
		// vi.mock's `withIpcErrorLogging` preserves the rejection.
		//
		// Every negative case must also assert that writeCueConfigFile was
		// NOT called — rejecting the promptFile loop must abort the whole
		// save, otherwise the YAML would land on disk while referencing a
		// prompt file that was never written.
		describe('prompt-file path hardening', () => {
			it('rejects empty string keys', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '': 'x' },
					})
				).rejects.toThrow(/must be a non-empty string/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects absolute paths', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '/etc/passwd.md': 'x' },
					})
				).rejects.toThrow(/must be a relative path/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths with parent-directory segments', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '../../escape.md': 'x' },
					})
				).rejects.toThrow(/"\." or "\.\." segment/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths with single-dot segments', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '.maestro/prompts/./sub.md': 'x' },
					})
				).rejects.toThrow(/"\." or "\.\." segment/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths that resolve outside .maestro/prompts/', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { 'not-prompts/file.md': 'x' },
					})
				).rejects.toThrow(/resolves outside the .maestro\/prompts directory/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects paths with mixed-in parent segments that pre-normalize to a valid location', async () => {
				// 'prompts/../../escape.md' — .split('/') catches the '..'
				// segment before path.resolve normalizes it away.
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '.maestro/prompts/../../escape.md': 'x' },
					})
				).rejects.toThrow(/"\." or "\.\." segment/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('rejects non-.md extensions', async () => {
				const handler = registerAndGetHandler('cue:writeYaml');
				await expect(
					handler(null, {
						projectRoot: '/projects/test',
						content: 'subscriptions: []',
						promptFiles: { '.maestro/prompts/payload.sh': 'x' },
					})
				).rejects.toThrow(/must end with .md/);
				expect(writeCuePromptFile).not.toHaveBeenCalled();
				expect(writeCueConfigFile).not.toHaveBeenCalled();
			});

			it('normalizes Windows backslash paths to forward-slash before writing', async () => {
				// Only meaningful on non-Windows, where path.sep is '/'. Windows
				// already accepts both separators via path.resolve.
				if (process.platform === 'win32') return;
				const handler = registerAndGetHandler('cue:writeYaml');
				await handler(null, {
					projectRoot: '/projects/test',
					content: 'subscriptions: []',
					promptFiles: { '.maestro\\prompts\\sub.md': 'body' },
				});
				// Normalized separator is stored as the written-file key.
				expect(writeCuePromptFile).toHaveBeenCalledWith(
					'/projects/test',
					'.maestro/prompts/sub.md',
					'body'
				);
			});
		});
	});

	describe('cue:deleteYaml', () => {
		it('should delegate to deleteCueConfigFile and return its result', async () => {
			vi.mocked(deleteCueConfigFile).mockReturnValue(true);

			const handler = registerAndGetHandler('cue:deleteYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe(true);
			expect(deleteCueConfigFile).toHaveBeenCalledWith('/projects/test');
		});

		it('returns false when there is nothing to delete', async () => {
			vi.mocked(deleteCueConfigFile).mockReturnValue(false);

			const handler = registerAndGetHandler('cue:deleteYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe(false);
		});

		it('prunes all .md prompt files and removes the empty prompts dir', async () => {
			// The "Remove Cue configuration" button must collapse the project's
			// `.maestro` footprint — deleting the yaml alone used to leave
			// orphaned prompt files behind forever.
			vi.mocked(deleteCueConfigFile).mockReturnValue(true);

			const handler = registerAndGetHandler('cue:deleteYaml');
			await handler(null, { projectRoot: '/projects/test' });

			// Keep-set is empty — everything in .maestro/prompts/ is orphaned.
			expect(pruneOrphanedPromptFiles).toHaveBeenCalledWith('/projects/test', []);
			// Then collapse the now-empty prompts directory, then .maestro/ itself.
			expect(removeEmptyPromptsDir).toHaveBeenCalledWith('/projects/test');
			expect(removeEmptyMaestroDir).toHaveBeenCalledWith('/projects/test');
		});

		it('prunes prompts even when the yaml file was already absent', async () => {
			// Users sometimes delete cue.yaml by hand, then click the Remove
			// button. Cleanup must still run so orphaned prompts don't linger.
			vi.mocked(deleteCueConfigFile).mockReturnValue(false);

			const handler = registerAndGetHandler('cue:deleteYaml');
			await handler(null, { projectRoot: '/projects/test' });

			expect(pruneOrphanedPromptFiles).toHaveBeenCalledWith('/projects/test', []);
			expect(removeEmptyPromptsDir).toHaveBeenCalledWith('/projects/test');
			expect(removeEmptyMaestroDir).toHaveBeenCalledWith('/projects/test');
		});
	});

	describe('cue:validateYaml', () => {
		it('should return valid result for valid YAML', async () => {
			const content = 'subscriptions: []';
			vi.mocked(yaml.load).mockReturnValue({ subscriptions: [] });
			vi.mocked(validateCueConfig).mockReturnValue({ valid: true, errors: [] });

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = await handler(null, { content });
			expect(result).toEqual({ valid: true, errors: [] });
			expect(yaml.load).toHaveBeenCalledWith(content);
			expect(validateCueConfig).toHaveBeenCalledWith({ subscriptions: [] });
		});

		it('should return errors for invalid config', async () => {
			const content = 'subscriptions: invalid';
			vi.mocked(yaml.load).mockReturnValue({ subscriptions: 'invalid' });
			vi.mocked(validateCueConfig).mockReturnValue({
				valid: false,
				errors: ['Config must have a "subscriptions" array'],
			});

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = await handler(null, { content });
			expect(result).toEqual({
				valid: false,
				errors: ['Config must have a "subscriptions" array'],
			});
		});

		it('should return parse error for malformed YAML', async () => {
			const content = '{{invalid yaml';
			vi.mocked(yaml.load).mockImplementation(() => {
				throw new Error('bad indentation');
			});

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = await handler(null, { content });
			expect(result).toEqual({
				valid: false,
				errors: ['YAML parse error: bad indentation'],
			});
		});
	});

	describe('edge cases', () => {
		it('cue:getStatus returns empty array when engine not started', async () => {
			// Engine exists but getStatus returns empty (no sessions registered)
			mockEngine.getStatus.mockReturnValue([]);

			const handler = registerAndGetHandler('cue:getStatus');
			const result = await handler(null);
			expect(result).toEqual([]);
			expect(mockEngine.getStatus).toHaveBeenCalledOnce();
		});

		it('cue:getActivityLog with limit returns bounded results', async () => {
			const manyEntries = Array.from({ length: 10 }, (_, i) => ({
				runId: `r${i}`,
				sessionId: 's1',
				sessionName: 'Test',
				subscriptionName: 'timer',
				event: {
					id: `e${i}`,
					type: 'time.heartbeat',
					timestamp: new Date().toISOString(),
					triggerName: 'timer',
					payload: {},
				},
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
			}));

			// Simulate engine returning only the last 2 entries (bounded by limit)
			mockEngine.getActivityLog.mockReturnValue(manyEntries.slice(-2));

			const handler = registerAndGetHandler('cue:getActivityLog');
			const result = await handler(null, { limit: 2 });

			expect(result).toHaveLength(2);
			expect(mockEngine.getActivityLog).toHaveBeenCalledWith(2);
		});

		it('cue:validateYaml handles empty content', async () => {
			// Empty string: yaml.load returns undefined/null for empty input
			vi.mocked(yaml.load).mockReturnValue(undefined);
			vi.mocked(validateCueConfig).mockReturnValue({
				valid: false,
				errors: ['Config must have a "subscriptions" array'],
			});

			const handler = registerAndGetHandler('cue:validateYaml');
			const result = (await handler(null, { content: '' })) as { valid: boolean; errors: string[] };

			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});

	describe('cue:savePipelineLayout', () => {
		it('should delegate to savePipelineLayout', async () => {
			const layout = {
				pipelines: [{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] }],
				selectedPipelineId: 'p1',
				viewport: { x: 0, y: 0, zoom: 1 },
			};

			const handler = registerAndGetHandler('cue:savePipelineLayout');
			await handler(null, { layout });
			expect(savePipelineLayout).toHaveBeenCalledWith(layout);
		});
	});

	describe('cue:triggerSubscription', () => {
		it('should pass subscriptionName to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, { subscriptionName: 'my-sub' });
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith('my-sub', undefined, undefined);
		});

		it('should pass prompt to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, { subscriptionName: 'my-sub', prompt: 'custom prompt' });
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith(
				'my-sub',
				'custom prompt',
				undefined
			);
		});

		it('should pass sourceAgentId to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, {
				subscriptionName: 'my-sub',
				sourceAgentId: 'agent-xyz-123',
			});
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith(
				'my-sub',
				undefined,
				'agent-xyz-123'
			);
		});

		it('should pass both prompt and sourceAgentId to engine.triggerSubscription()', async () => {
			const handler = registerAndGetHandler('cue:triggerSubscription');
			await handler(null, {
				subscriptionName: 'my-sub',
				prompt: 'override prompt',
				sourceAgentId: 'agent-abc',
			});
			expect(mockEngine.triggerSubscription).toHaveBeenCalledWith(
				'my-sub',
				'override prompt',
				'agent-abc'
			);
		});

		it('should return the boolean result from engine', async () => {
			mockEngine.triggerSubscription.mockReturnValue(false);
			const handler = registerAndGetHandler('cue:triggerSubscription');
			const result = await handler(null, { subscriptionName: 'nonexistent' });
			expect(result).toBe(false);
		});
	});

	describe('cue:loadPipelineLayout', () => {
		it('should return layout when file exists', async () => {
			const layout = {
				pipelines: [{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] }],
				selectedPipelineId: 'p1',
				viewport: { x: 100, y: 200, zoom: 1.5 },
			};
			vi.mocked(loadPipelineLayout).mockReturnValue(layout as any);

			const handler = registerAndGetHandler('cue:loadPipelineLayout');
			const result = await handler(null);
			expect(result).toEqual(layout);
		});

		it('should return null when file does not exist', async () => {
			vi.mocked(loadPipelineLayout).mockReturnValue(null);

			const handler = registerAndGetHandler('cue:loadPipelineLayout');
			const result = await handler(null);
			expect(result).toBeNull();
		});
	});
});
