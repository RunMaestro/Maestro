/**
 * Tests for src/main/utils/ipcHandler.ts
 *
 * Tests cover the IPC handler utilities that provide standardized
 * error handling, logging, and response formats for IPC handlers.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createHandler,
	createDataHandler,
	createIpcHandler,
	createIpcDataHandler,
	withErrorLogging,
	withIpcErrorLogging,
	requireProcessManager,
	requireDependency,
	type IpcResponse,
	type IpcCustomResponse,
} from '../../../main/utils/ipcHandler';

// Mock the logger module
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
	},
}));

import { logger } from '../../../main/utils/logger';

describe('ipcHandler.ts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('createHandler', () => {
		it('should return success response with handler result', async () => {
			const handler = createHandler(
				{ context: '[Test]', operation: 'testOp' },
				async (value: string) => ({ result: value.toUpperCase() })
			);

			const result = await handler('hello');

			expect(result).toEqual({
				success: true,
				result: 'HELLO',
			});
		});

		it('should log success with context and operation', async () => {
			const handler = createHandler({ context: '[AutoRun]', operation: 'listDocs' }, async () => ({
				files: [],
			}));

			await handler();

			expect(logger.info).toHaveBeenCalledWith('listDocs success', '[AutoRun]', undefined);
		});

		it('should include successLogData in log', async () => {
			const handler = createHandler(
				{ context: '[Test]', operation: 'op', successLogData: { count: 5 } },
				async () => ({ items: [] })
			);

			await handler();

			expect(logger.info).toHaveBeenCalledWith('op success', '[Test]', { count: 5 });
		});

		it('should not log success when logSuccess is false', async () => {
			const handler = createHandler(
				{ context: '[Test]', operation: 'op', logSuccess: false },
				async () => ({ data: 'value' })
			);

			await handler();

			expect(logger.info).not.toHaveBeenCalled();
		});

		it('should return error response on handler failure', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'failOp' }, async () => {
				throw new Error('Something went wrong');
			});

			const result = await handler();

			expect(result).toEqual({
				success: false,
				error: 'Error: Something went wrong',
			});
		});

		it('should log error with context and error object', async () => {
			const error = new Error('Test error');
			const handler = createHandler({ context: '[Git]', operation: 'checkout' }, async () => {
				throw error;
			});

			await handler();

			expect(logger.error).toHaveBeenCalledWith('checkout error', '[Git]', error);
		});

		it('should handle multiple arguments', async () => {
			const handler = createHandler(
				{ context: '[Test]', operation: 'multi' },
				async (a: string, b: number, c: boolean) => ({
					combined: `${a}-${b}-${c}`,
				})
			);

			const result = await handler('str', 42, true);

			expect(result).toEqual({
				success: true,
				combined: 'str-42-true',
			});
		});

		it('should handle async operations', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'async' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { delayed: true };
			});

			const result = await handler();

			expect(result).toEqual({
				success: true,
				delayed: true,
			});
		});

		it('should handle non-Error thrown values', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'throwString' }, async () => {
				throw 'string error';
			});

			const result = await handler();

			expect(result).toEqual({
				success: false,
				error: 'string error',
			});
		});

		it('should preserve complex return types', async () => {
			type ComplexResult = {
				files: string[];
				tree: { name: string; children: string[] }[];
				count: number;
			};

			const handler = createHandler<[], ComplexResult>(
				{ context: '[Test]', operation: 'complex' },
				async () => ({
					files: ['a.md', 'b.md'],
					tree: [{ name: 'folder', children: ['c.md'] }],
					count: 3,
				})
			);

			const result = await handler();

			expect(result).toEqual({
				success: true,
				files: ['a.md', 'b.md'],
				tree: [{ name: 'folder', children: ['c.md'] }],
				count: 3,
			});
		});
	});

	describe('createDataHandler', () => {
		it('should wrap result in { success: true, data }', async () => {
			const handler = createDataHandler(
				{ context: '[Test]', operation: 'getData' },
				async () => 'result value'
			);

			const result = await handler();

			expect(result).toEqual({
				success: true,
				data: 'result value',
			});
		});

		it('should return error response on failure', async () => {
			const handler = createDataHandler({ context: '[Test]', operation: 'failData' }, async () => {
				throw new Error('Data fetch failed');
			});

			const result = await handler();

			expect(result).toEqual({
				success: false,
				error: 'Error: Data fetch failed',
			});
		});

		it('should handle complex data types', async () => {
			interface UserData {
				id: number;
				name: string;
				roles: string[];
			}

			const handler = createDataHandler<[], UserData>(
				{ context: '[Test]', operation: 'getUser' },
				async () => ({
					id: 1,
					name: 'Test User',
					roles: ['admin', 'user'],
				})
			);

			const result = await handler();

			expect(result).toEqual({
				success: true,
				data: {
					id: 1,
					name: 'Test User',
					roles: ['admin', 'user'],
				},
			});
		});

		it('should handle null and undefined data', async () => {
			const nullHandler = createDataHandler(
				{ context: '[Test]', operation: 'nullData' },
				async () => null
			);

			const undefinedHandler = createDataHandler(
				{ context: '[Test]', operation: 'undefinedData' },
				async () => undefined
			);

			const nullResult = await nullHandler();
			const undefinedResult = await undefinedHandler();

			expect(nullResult).toEqual({ success: true, data: null });
			expect(undefinedResult).toEqual({ success: true, data: undefined });
		});

		it('should pass arguments to handler', async () => {
			const handler = createDataHandler(
				{ context: '[Test]', operation: 'withArgs' },
				async (id: number, prefix: string) => `${prefix}-${id}`
			);

			const result = await handler(42, 'item');

			expect(result).toEqual({
				success: true,
				data: 'item-42',
			});
		});

		it('should log success with context', async () => {
			const handler = createDataHandler(
				{ context: '[Playbooks]', operation: 'list' },
				async () => []
			);

			await handler();

			expect(logger.info).toHaveBeenCalledWith('list success', '[Playbooks]', undefined);
		});
	});

	describe('withErrorLogging', () => {
		it('should return handler result directly (no wrapping)', async () => {
			const handler = withErrorLogging(
				{ context: '[Test]', operation: 'direct' },
				async () => 'direct result'
			);

			const result = await handler();

			expect(result).toBe('direct result');
		});

		it('should re-throw errors after logging', async () => {
			const error = new Error('Operation failed');
			const handler = withErrorLogging({ context: '[Test]', operation: 'throw' }, async () => {
				throw error;
			});

			await expect(handler()).rejects.toThrow('Operation failed');
			expect(logger.error).toHaveBeenCalledWith('throw error', '[Test]', error);
		});

		it('should not log on success', async () => {
			const handler = withErrorLogging(
				{ context: '[Test]', operation: 'success' },
				async () => 'ok'
			);

			await handler();

			expect(logger.info).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
		});

		it('should pass arguments to handler', async () => {
			const handler = withErrorLogging(
				{ context: '[Test]', operation: 'args' },
				async (a: number, b: number) => a + b
			);

			const result = await handler(10, 20);

			expect(result).toBe(30);
		});

		it('should preserve return type', async () => {
			interface ProcessResult {
				pid: number;
				status: string;
			}

			const handler = withErrorLogging<[string], ProcessResult>(
				{ context: '[Process]', operation: 'spawn' },
				async (cmd: string) => ({
					pid: 1234,
					status: `running: ${cmd}`,
				})
			);

			const result = await handler('npm start');

			expect(result).toEqual({
				pid: 1234,
				status: 'running: npm start',
			});
		});
	});

	describe('withIpcErrorLogging', () => {
		it('should strip event argument and pass remaining args to handler', async () => {
			const handler = withIpcErrorLogging(
				{ context: '[History]', operation: 'getAll' },
				async (projectPath: string) => [`${projectPath}/entry1`, `${projectPath}/entry2`]
			);

			// ipcMain.handle passes (event, ...args), simulate this
			const mockEvent = { sender: {} };
			const result = await handler(mockEvent, '/test/project');

			expect(result).toEqual(['/test/project/entry1', '/test/project/entry2']);
		});

		it('should return handler result directly (no wrapping)', async () => {
			const handler = withIpcErrorLogging(
				{ context: '[Test]', operation: 'direct' },
				async () => 'direct result'
			);

			const result = await handler({});

			expect(result).toBe('direct result');
		});

		it('should handle multiple arguments after event', async () => {
			const handler = withIpcErrorLogging(
				{ context: '[Test]', operation: 'multi' },
				async (a: string, b: number, c: boolean) => ({ combined: `${a}-${b}-${c}` })
			);

			const result = await handler({}, 'str', 42, true);

			expect(result).toEqual({ combined: 'str-42-true' });
		});

		it('should re-throw errors after logging', async () => {
			const error = new Error('Operation failed');
			const handler = withIpcErrorLogging(
				{ context: '[History]', operation: 'getAll' },
				async () => {
					throw error;
				}
			);

			await expect(handler({})).rejects.toThrow('Operation failed');
			expect(logger.error).toHaveBeenCalledWith('getAll error', '[History]', error);
		});

		it('should not log on success', async () => {
			const handler = withIpcErrorLogging(
				{ context: '[Test]', operation: 'success' },
				async () => 'ok'
			);

			await handler({});

			expect(logger.info).not.toHaveBeenCalled();
			expect(logger.error).not.toHaveBeenCalled();
		});

		it('should preserve complex return types', async () => {
			interface HistoryEntry {
				id: string;
				timestamp: number;
				summary: string;
			}

			const handler = withIpcErrorLogging<[string], HistoryEntry[]>(
				{ context: '[History]', operation: 'getEntries' },
				async (sessionId: string) => [
					{ id: '1', timestamp: Date.now(), summary: `Entry for ${sessionId}` },
					{ id: '2', timestamp: Date.now(), summary: 'Second entry' },
				]
			);

			const result = await handler({}, 'session-123');

			expect(result).toHaveLength(2);
			expect(result[0].summary).toBe('Entry for session-123');
		});

		it('should handle no arguments after event', async () => {
			const handler = withIpcErrorLogging({ context: '[Test]', operation: 'noArgs' }, async () => [
				'item1',
				'item2',
			]);

			const result = await handler({});

			expect(result).toEqual(['item1', 'item2']);
		});

		it('should handle optional arguments after event', async () => {
			const handler = withIpcErrorLogging(
				{ context: '[History]', operation: 'clear' },
				async (projectPath?: string, sessionId?: string) => {
					if (sessionId) return `cleared session: ${sessionId}`;
					if (projectPath) return `cleared project: ${projectPath}`;
					return 'cleared all';
				}
			);

			expect(await handler({})).toBe('cleared all');
			expect(await handler({}, '/project/path')).toBe('cleared project: /project/path');
			expect(await handler({}, '/project/path', 'session-1')).toBe('cleared session: session-1');
		});
	});

	describe('requireProcessManager', () => {
		it('should return ProcessManager when initialized', () => {
			const mockProcessManager = { spawn: vi.fn(), kill: vi.fn() };
			const getter = () => mockProcessManager as any;

			const result = requireProcessManager(getter);

			expect(result).toBe(mockProcessManager);
		});

		it('should throw when ProcessManager is null', () => {
			const getter = () => null;

			expect(() => requireProcessManager(getter)).toThrow('Process manager not initialized');
		});

		it('should work with actual getter pattern', () => {
			let processManager: any = null;
			const getProcessManager = () => processManager;

			// Initially null
			expect(() => requireProcessManager(getProcessManager)).toThrow(
				'Process manager not initialized'
			);

			// After initialization
			processManager = { spawn: vi.fn() };
			expect(requireProcessManager(getProcessManager)).toBe(processManager);
		});
	});

	describe('requireDependency', () => {
		it('should return dependency when initialized', () => {
			const mockDep = { doSomething: vi.fn() };
			const getter = () => mockDep;

			const result = requireDependency(getter, 'Test dependency');

			expect(result).toBe(mockDep);
		});

		it('should throw with custom name when dependency is null', () => {
			const getter = () => null;

			expect(() => requireDependency(getter, 'Agent detector')).toThrow(
				'Agent detector not initialized'
			);
		});

		it('should handle various dependency types', () => {
			const stringGetter = () => 'string value';
			const numberGetter = () => 42;
			const objectGetter = () => ({ key: 'value' });

			expect(requireDependency(stringGetter, 'String')).toBe('string value');
			expect(requireDependency(numberGetter, 'Number')).toBe(42);
			expect(requireDependency(objectGetter, 'Object')).toEqual({ key: 'value' });
		});

		it('should work with typed generics', () => {
			interface AgentDetector {
				detect: () => string[];
				getAgent: (id: string) => { name: string };
			}

			const mockDetector: AgentDetector = {
				detect: () => ['claude', 'gpt'],
				getAgent: (id) => ({ name: id }),
			};

			const getter = () => mockDetector;
			const detector = requireDependency<AgentDetector>(getter, 'AgentDetector');

			expect(detector.detect()).toEqual(['claude', 'gpt']);
			expect(detector.getAgent('claude')).toEqual({ name: 'claude' });
		});
	});

	describe('type safety', () => {
		it('IpcResponse type should distinguish success and error', () => {
			const successResponse: IpcResponse<string> = {
				success: true,
				data: 'test',
			};

			const errorResponse: IpcResponse<string> = {
				success: false,
				error: 'failed',
			};

			// Type narrowing should work
			if (successResponse.success) {
				expect(successResponse.data).toBe('test');
			}

			if (!errorResponse.success) {
				expect(errorResponse.error).toBe('failed');
			}
		});

		it('IpcCustomResponse type should work with custom shapes', () => {
			type ListResponse = IpcCustomResponse<{ files: string[]; count: number }>;

			const successResponse: ListResponse = {
				success: true,
				files: ['a', 'b'],
				count: 2,
			};

			const errorResponse: ListResponse = {
				success: false,
				error: 'failed to list',
			};

			if (successResponse.success) {
				expect(successResponse.files).toEqual(['a', 'b']);
				expect(successResponse.count).toBe(2);
			}

			if (!errorResponse.success) {
				expect(errorResponse.error).toBe('failed to list');
			}
		});
	});

	describe('edge cases', () => {
		it('should handle empty result objects', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'empty' }, async () => ({}));

			const result = await handler();

			expect(result).toEqual({ success: true });
		});

		it('should handle Promise rejection', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'reject' }, async () =>
				Promise.reject(new Error('Rejected'))
			);

			const result = await handler();

			expect(result).toEqual({
				success: false,
				error: 'Error: Rejected',
			});
		});

		it('should handle synchronous errors in async function', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'sync' }, async () => {
				JSON.parse('invalid json');
				return { never: 'reached' };
			});

			const result = await handler();

			expect(result.success).toBe(false);
			expect((result as any).error).toContain('JSON');
		});

		it('should handle errors thrown before async operation', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'earlyThrow' }, async () => {
				throw new Error('Early throw');
				// eslint-disable-next-line no-unreachable
				await Promise.resolve();
				return { value: 'unreachable' };
			});

			const result = await handler();

			expect(result).toEqual({
				success: false,
				error: 'Error: Early throw',
			});
		});

		it('should handle undefined thrown value', async () => {
			const handler = createHandler(
				{ context: '[Test]', operation: 'undefinedThrow' },
				async () => {
					// eslint-disable-next-line @typescript-eslint/only-throw-error
					throw undefined;
				}
			);

			const result = await handler();

			expect(result).toEqual({
				success: false,
				error: 'undefined',
			});
		});

		it('should handle object thrown value', async () => {
			const handler = createHandler({ context: '[Test]', operation: 'objectThrow' }, async () => {
				// eslint-disable-next-line @typescript-eslint/only-throw-error
				throw { code: 'ERR_001', message: 'Custom error' };
			});

			const result = await handler();

			expect(result.success).toBe(false);
			// String() on an object returns '[object Object]'
			expect((result as any).error).toBe('[object Object]');
		});
	});

	describe('createIpcHandler', () => {
		it('should strip event argument and pass remaining args to handler', async () => {
			const handler = createIpcHandler(
				{ context: '[AutoRun]', operation: 'listDocs' },
				async (folderPath: string) => ({ files: [folderPath], tree: [] })
			);

			// ipcMain.handle passes (event, ...args), simulate this
			const mockEvent = { sender: {} };
			const result = await handler(mockEvent, '/test/path');

			expect(result).toEqual({
				success: true,
				files: ['/test/path'],
				tree: [],
			});
		});

		it('should handle multiple arguments after event', async () => {
			const handler = createIpcHandler(
				{ context: '[Test]', operation: 'multi' },
				async (a: string, b: number, c: boolean) => ({
					combined: `${a}-${b}-${c}`,
				})
			);

			const result = await handler({}, 'str', 42, true);

			expect(result).toEqual({
				success: true,
				combined: 'str-42-true',
			});
		});

		it('should return error response on handler failure', async () => {
			const handler = createIpcHandler({ context: '[Test]', operation: 'failOp' }, async () => {
				throw new Error('Handler failed');
			});

			const result = await handler({});

			expect(result).toEqual({
				success: false,
				error: 'Error: Handler failed',
			});
		});

		it('should log success with context and operation', async () => {
			const handler = createIpcHandler(
				{ context: '[AutoRun]', operation: 'readDoc' },
				async () => ({ content: 'test' })
			);

			await handler({});

			expect(logger.info).toHaveBeenCalledWith('readDoc success', '[AutoRun]', undefined);
		});

		it('should log error with context and error object', async () => {
			const error = new Error('Test error');
			const handler = createIpcHandler(
				{ context: '[AutoRun]', operation: 'writeDoc' },
				async () => {
					throw error;
				}
			);

			await handler({});

			expect(logger.error).toHaveBeenCalledWith('writeDoc error', '[AutoRun]', error);
		});

		it('should not log success when logSuccess is false', async () => {
			const handler = createIpcHandler(
				{ context: '[Test]', operation: 'op', logSuccess: false },
				async () => ({ data: 'value' })
			);

			await handler({});

			expect(logger.info).not.toHaveBeenCalled();
		});
	});

	describe('createIpcDataHandler', () => {
		it('should strip event argument and wrap result in { success, data }', async () => {
			const handler = createIpcDataHandler(
				{ context: '[Test]', operation: 'getData' },
				async (id: string) => ({ id, name: 'test' })
			);

			const mockEvent = { sender: {} };
			const result = await handler(mockEvent, '123');

			expect(result).toEqual({
				success: true,
				data: { id: '123', name: 'test' },
			});
		});

		it('should handle multiple arguments after event', async () => {
			const handler = createIpcDataHandler(
				{ context: '[Test]', operation: 'combine' },
				async (a: string, b: number) => `${a}-${b}`
			);

			const result = await handler({}, 'prefix', 42);

			expect(result).toEqual({
				success: true,
				data: 'prefix-42',
			});
		});

		it('should return error response on failure', async () => {
			const handler = createIpcDataHandler(
				{ context: '[Test]', operation: 'failData' },
				async () => {
					throw new Error('Data fetch failed');
				}
			);

			const result = await handler({});

			expect(result).toEqual({
				success: false,
				error: 'Error: Data fetch failed',
			});
		});

		it('should log success with context', async () => {
			const handler = createIpcDataHandler(
				{ context: '[Settings]', operation: 'get' },
				async () => 'value'
			);

			await handler({});

			expect(logger.info).toHaveBeenCalledWith('get success', '[Settings]', undefined);
		});

		it('should handle null and undefined data', async () => {
			const nullHandler = createIpcDataHandler(
				{ context: '[Test]', operation: 'nullData' },
				async () => null
			);

			const undefinedHandler = createIpcDataHandler(
				{ context: '[Test]', operation: 'undefinedData' },
				async () => undefined
			);

			const nullResult = await nullHandler({});
			const undefinedResult = await undefinedHandler({});

			expect(nullResult).toEqual({ success: true, data: null });
			expect(undefinedResult).toEqual({ success: true, data: undefined });
		});
	});

	describe('integration patterns', () => {
		it('should work with IPC handler pattern', async () => {
			// Simulating the pattern used in ipcMain.handle
			const handlers: Record<string, (...args: any[]) => Promise<any>> = {};

			// Register handler using createHandler
			handlers['autorun:listDocs'] = createHandler(
				{ context: '[AutoRun]', operation: 'listDocs' },
				async (folderPath: string) => {
					// Simulate scanning directory
					return {
						files: [`${folderPath}/doc1`, `${folderPath}/doc2`],
						tree: [],
					};
				}
			);

			// Call handler as IPC would
			const result = await handlers['autorun:listDocs']('/path/to/docs');

			expect(result).toEqual({
				success: true,
				files: ['/path/to/docs/doc1', '/path/to/docs/doc2'],
				tree: [],
			});
		});

		it('should work with requireProcessManager in handler', async () => {
			let processManager: any = { write: vi.fn().mockReturnValue(true) };
			const getProcessManager = () => processManager;

			const handler = withErrorLogging(
				{ context: '[Process]', operation: 'write' },
				async (sessionId: string, data: string) => {
					const pm = requireProcessManager(getProcessManager);
					return pm.write(sessionId, data);
				}
			);

			const result = await handler('session-1', 'hello');

			expect(result).toBe(true);
			expect(processManager.write).toHaveBeenCalledWith('session-1', 'hello');
		});

		it('should properly chain requireDependency with createHandler', async () => {
			interface MockAgent {
				name: string;
				execute: (cmd: string) => Promise<string>;
			}

			const mockAgent: MockAgent = {
				name: 'claude',
				execute: async (cmd) => `executed: ${cmd}`,
			};

			const getAgent = () => mockAgent;

			const handler = createHandler(
				{ context: '[Agent]', operation: 'runCommand' },
				async (command: string) => {
					const agent = requireDependency(getAgent, 'Agent');
					const output = await agent.execute(command);
					return { output, agent: agent.name };
				}
			);

			const result = await handler('npm test');

			expect(result).toEqual({
				success: true,
				output: 'executed: npm test',
				agent: 'claude',
			});
		});
	});
});
