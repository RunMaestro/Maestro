/**
 * Tests for logger preload API
 *
 * Coverage:
 * - createLoggerApi: log, getLogs, clearLogs, setLogLevel, getLogLevel, setMaxLogBuffer,
 *   getMaxLogBuffer, toast, autorun, onNewLog, getLogFilePath, isFileLoggingEnabled, enableFileLogging
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createLoggerApi } from '../../../main/preload/logger';

describe('Logger Preload API', () => {
	let api: ReturnType<typeof createLoggerApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createLoggerApi();
	});

	describe('log', () => {
		it('should invoke logger:log with level and message', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.log('info', 'Test message');

			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'info',
				'Test message',
				undefined,
				undefined
			);
		});

		it('should invoke logger:log with context and data', async () => {
			mockInvoke.mockResolvedValue(undefined);
			const data = { key: 'value' };

			await api.log('error', 'Error occurred', 'MyContext', data);

			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'error',
				'Error occurred',
				'MyContext',
				data
			);
		});
	});

	describe('getLogs', () => {
		it('should invoke logger:getLogs without filter', async () => {
			const logs = [{ level: 'info', message: 'Test', timestamp: Date.now() }];
			mockInvoke.mockResolvedValue(logs);

			const result = await api.getLogs();

			expect(mockInvoke).toHaveBeenCalledWith('logger:getLogs', undefined);
			expect(result).toEqual(logs);
		});

		it('should invoke logger:getLogs with filter', async () => {
			mockInvoke.mockResolvedValue([]);
			const filter = { level: 'error' as const, context: 'Test', limit: 100 };

			await api.getLogs(filter);

			expect(mockInvoke).toHaveBeenCalledWith('logger:getLogs', filter);
		});
	});

	describe('clearLogs', () => {
		it('should invoke logger:clearLogs', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.clearLogs();

			expect(mockInvoke).toHaveBeenCalledWith('logger:clearLogs');
		});
	});

	describe('setLogLevel', () => {
		it('should invoke logger:setLogLevel', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.setLogLevel('debug');

			expect(mockInvoke).toHaveBeenCalledWith('logger:setLogLevel', 'debug');
		});
	});

	describe('getLogLevel', () => {
		it('should invoke logger:getLogLevel', async () => {
			mockInvoke.mockResolvedValue('info');

			const result = await api.getLogLevel();

			expect(mockInvoke).toHaveBeenCalledWith('logger:getLogLevel');
			expect(result).toBe('info');
		});
	});

	describe('setMaxLogBuffer', () => {
		it('should invoke logger:setMaxLogBuffer', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.setMaxLogBuffer(500);

			expect(mockInvoke).toHaveBeenCalledWith('logger:setMaxLogBuffer', 500);
		});
	});

	describe('getMaxLogBuffer', () => {
		it('should invoke logger:getMaxLogBuffer', async () => {
			mockInvoke.mockResolvedValue(1000);

			const result = await api.getMaxLogBuffer();

			expect(mockInvoke).toHaveBeenCalledWith('logger:getMaxLogBuffer');
			expect(result).toBe(1000);
		});
	});

	describe('toast', () => {
		it('should invoke logger:log with toast level', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.toast('Notification title');

			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'toast',
				'Notification title',
				'Toast',
				undefined
			);
		});

		it('should invoke with data', async () => {
			mockInvoke.mockResolvedValue(undefined);
			const data = { action: 'clicked' };

			await api.toast('Notification', data);

			expect(mockInvoke).toHaveBeenCalledWith('logger:log', 'toast', 'Notification', 'Toast', data);
		});
	});

	describe('autorun', () => {
		it('should invoke logger:log with autorun level', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.autorun('Task started');

			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'autorun',
				'Task started',
				'AutoRun',
				undefined
			);
		});

		it('should invoke with custom context', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.autorun('Task completed', 'Playbook');

			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'autorun',
				'Task completed',
				'Playbook',
				undefined
			);
		});

		it('should invoke with data', async () => {
			mockInvoke.mockResolvedValue(undefined);
			const data = { taskIndex: 5 };

			await api.autorun('Processing', 'AutoRun', data);

			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'autorun',
				'Processing',
				'AutoRun',
				data
			);
		});
	});

	describe('onNewLog', () => {
		it('should register event listener and return cleanup function', () => {
			const callback = vi.fn();

			const cleanup = api.onNewLog(callback);

			expect(mockOn).toHaveBeenCalledWith('logger:newLog', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback when event is received', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, log: unknown) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, log: unknown) => void) => {
					registeredHandler = handler;
				}
			);

			api.onNewLog(callback);

			const logEntry = { level: 'info', message: 'Test', timestamp: Date.now() };
			registeredHandler!({}, logEntry);

			expect(callback).toHaveBeenCalledWith(logEntry);
		});

		it('should remove listener when cleanup is called', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, log: unknown) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, log: unknown) => void) => {
					registeredHandler = handler;
				}
			);

			const cleanup = api.onNewLog(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith('logger:newLog', registeredHandler!);
		});
	});

	describe('getLogFilePath', () => {
		it('should invoke logger:getLogFilePath', async () => {
			mockInvoke.mockResolvedValue('/path/to/logs/maestro.log');

			const result = await api.getLogFilePath();

			expect(mockInvoke).toHaveBeenCalledWith('logger:getLogFilePath');
			expect(result).toBe('/path/to/logs/maestro.log');
		});
	});

	describe('isFileLoggingEnabled', () => {
		it('should invoke logger:isFileLoggingEnabled', async () => {
			mockInvoke.mockResolvedValue(true);

			const result = await api.isFileLoggingEnabled();

			expect(mockInvoke).toHaveBeenCalledWith('logger:isFileLoggingEnabled');
			expect(result).toBe(true);
		});
	});

	describe('enableFileLogging', () => {
		it('should invoke logger:enableFileLogging', async () => {
			mockInvoke.mockResolvedValue(undefined);

			await api.enableFileLogging();

			expect(mockInvoke).toHaveBeenCalledWith('logger:enableFileLogging');
		});
	});
});
