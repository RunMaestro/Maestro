/**
 * Tests for Cue IPC handlers.
 *
 * Tests cover:
 * - Handler registration with ipcMain.handle
 * - Delegation to CueEngine methods (getStatus, getActiveRuns, etc.)
 * - YAML read/write/validate operations
 * - Engine enable/disable controls
 * - Error handling when engine is not initialized
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Track registered IPC handlers
const registeredHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn((name: string) => `/mock-user-data/${name}`),
	},
	ipcMain: {
		handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
			registeredHandlers.set(channel, handler);
		}),
	},
}));

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock('path', async () => {
	const actual = await vi.importActual<typeof import('path')>('path');
	return {
		...actual,
		join: vi.fn((...args: string[]) => args.join('/')),
	};
});

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
}));

vi.mock('../../../main/cue/cue-types', () => ({
	CUE_YAML_FILENAME: 'maestro-cue.yaml',
}));

import { registerCueHandlers } from '../../../main/ipc/handlers/cue';
import { validateCueConfig } from '../../../main/cue/cue-yaml-loader';
import * as yaml from 'js-yaml';

// Create a mock CueEngine
function createMockEngine() {
	return {
		getStatus: vi.fn().mockReturnValue([]),
		getActiveRuns: vi.fn().mockReturnValue([]),
		getActivityLog: vi.fn().mockReturnValue([]),
		start: vi.fn(),
		stop: vi.fn(),
		stopRun: vi.fn().mockReturnValue(true),
		stopAll: vi.fn(),
		refreshSession: vi.fn(),
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
				'cue:getStatus',
				'cue:getActiveRuns',
				'cue:getActivityLog',
				'cue:enable',
				'cue:disable',
				'cue:stopRun',
				'cue:stopAll',
				'cue:refreshSession',
				'cue:readYaml',
				'cue:writeYaml',
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
		it('should call engine.start()', async () => {
			const handler = registerAndGetHandler('cue:enable');
			await handler(null);
			expect(mockEngine.start).toHaveBeenCalledOnce();
		});
	});

	describe('cue:disable', () => {
		it('should call engine.stop()', async () => {
			const handler = registerAndGetHandler('cue:disable');
			await handler(null);
			expect(mockEngine.stop).toHaveBeenCalledOnce();
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
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue('subscriptions: []');

			const handler = registerAndGetHandler('cue:readYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBe('subscriptions: []');
			expect(fs.existsSync).toHaveBeenCalledWith('/projects/test/maestro-cue.yaml');
			expect(fs.readFileSync).toHaveBeenCalledWith('/projects/test/maestro-cue.yaml', 'utf-8');
		});

		it('should return null when file does not exist', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const handler = registerAndGetHandler('cue:readYaml');
			const result = await handler(null, { projectRoot: '/projects/test' });
			expect(result).toBeNull();
			expect(fs.readFileSync).not.toHaveBeenCalled();
		});
	});

	describe('cue:writeYaml', () => {
		it('should write content to the correct file path', async () => {
			const content = 'subscriptions:\n  - name: test\n    event: time.interval';

			const handler = registerAndGetHandler('cue:writeYaml');
			await handler(null, { projectRoot: '/projects/test', content });
			expect(fs.writeFileSync).toHaveBeenCalledWith(
				'/projects/test/maestro-cue.yaml',
				content,
				'utf-8'
			);
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

	describe('cue:savePipelineLayout', () => {
		it('should write layout to JSON file', async () => {
			const layout = {
				pipelines: [{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] }],
				selectedPipelineId: 'p1',
				viewport: { x: 0, y: 0, zoom: 1 },
			};

			const handler = registerAndGetHandler('cue:savePipelineLayout');
			await handler(null, { layout });
			expect(fs.writeFileSync).toHaveBeenCalledWith(
				expect.stringContaining('cue-pipeline-layout.json'),
				JSON.stringify(layout, null, 2),
				'utf-8'
			);
		});
	});

	describe('cue:loadPipelineLayout', () => {
		it('should return layout when file exists', async () => {
			const layout = {
				pipelines: [{ id: 'p1', name: 'Pipeline 1', color: '#06b6d4', nodes: [], edges: [] }],
				selectedPipelineId: 'p1',
				viewport: { x: 100, y: 200, zoom: 1.5 },
			};
			vi.mocked(fs.existsSync).mockReturnValue(true);
			vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(layout));

			const handler = registerAndGetHandler('cue:loadPipelineLayout');
			const result = await handler(null);
			expect(result).toEqual(layout);
		});

		it('should return null when file does not exist', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);

			const handler = registerAndGetHandler('cue:loadPipelineLayout');
			const result = await handler(null);
			expect(result).toBeNull();
		});
	});
});
