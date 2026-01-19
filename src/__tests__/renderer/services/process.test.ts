/**
 * Tests for src/renderer/services/process.ts
 * Process management service that wraps IPC calls to main process
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
	processService,
	ProcessConfig,
	ProcessDataHandler,
	ProcessExitHandler,
	ProcessSessionIdHandler,
} from '../../../renderer/services/process';

// Mock the window.maestro.process object
const mockProcess = {
	spawn: vi.fn(),
	write: vi.fn(),
	interrupt: vi.fn(),
	kill: vi.fn(),
	resize: vi.fn(),
	onData: vi.fn(),
	onExit: vi.fn(),
	onSessionId: vi.fn(),
};

// Setup mock before each test
beforeEach(() => {
	vi.clearAllMocks();

	// Ensure window.maestro.process is mocked
	(window as any).maestro = {
		...(window as any).maestro,
		process: mockProcess,
	};

	// Mock console.error to prevent noise in test output
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('processService', () => {
	describe('spawn', () => {
		const baseConfig = {
			toolType: 'claude-code',
			cwd: '/path/to/project',
			command: 'claude-code',
			args: ['--print'],
		};

		test('spawns a process with correct session ID and config', async () => {
			const testConfig: ProcessConfig = {
				...baseConfig,
				sessionId: 'session-1',
			};
			mockProcess.spawn.mockResolvedValue(undefined);

			await processService.spawn(testConfig);

			expect(mockProcess.spawn).toHaveBeenCalledWith(testConfig);
			expect(mockProcess.spawn).toHaveBeenCalledTimes(1);
		});

		test('spawns terminal process with terminal tool type', async () => {
			const terminalConfig: ProcessConfig = {
				...baseConfig,
				sessionId: 'session-terminal',
				toolType: 'terminal',
				cwd: '/home/user',
				command: '/bin/bash',
				args: [],
			};
			mockProcess.spawn.mockResolvedValue(undefined);

			await processService.spawn(terminalConfig);

			expect(mockProcess.spawn).toHaveBeenCalledWith(terminalConfig);
		});

		test('throws error and logs when spawn fails', async () => {
			const error = new Error('Failed to spawn process');
			const testConfig: ProcessConfig = {
				...baseConfig,
				sessionId: 'session-1',
			};
			mockProcess.spawn.mockRejectedValue(error);

			await expect(processService.spawn(testConfig)).rejects.toThrow('Failed to spawn process');
			expect(console.error).toHaveBeenCalledWith('Process spawn error:', error);
		});

		test('handles different session IDs', async () => {
			const sessionConfigOne: ProcessConfig = {
				...baseConfig,
				sessionId: 'ai-session-123',
			};
			const sessionConfigTwo: ProcessConfig = {
				...baseConfig,
				sessionId: 'terminal-session-456',
			};
			mockProcess.spawn.mockResolvedValue(undefined);

			await processService.spawn(sessionConfigOne);
			await processService.spawn(sessionConfigTwo);

			expect(mockProcess.spawn).toHaveBeenNthCalledWith(1, sessionConfigOne);
			expect(mockProcess.spawn).toHaveBeenNthCalledWith(2, sessionConfigTwo);
		});
	});

	describe('write', () => {
		test('writes data to process stdin', async () => {
			mockProcess.write.mockResolvedValue(undefined);

			await processService.write('session-1', 'hello world');

			expect(mockProcess.write).toHaveBeenCalledWith('session-1', 'hello world');
			expect(mockProcess.write).toHaveBeenCalledTimes(1);
		});

		test('writes empty string', async () => {
			mockProcess.write.mockResolvedValue(undefined);

			await processService.write('session-1', '');

			expect(mockProcess.write).toHaveBeenCalledWith('session-1', '');
		});

		test('writes multiline data', async () => {
			mockProcess.write.mockResolvedValue(undefined);
			const multilineData = 'line1\nline2\nline3';

			await processService.write('session-1', multilineData);

			expect(mockProcess.write).toHaveBeenCalledWith('session-1', multilineData);
		});

		test('writes control characters (newline for submission)', async () => {
			mockProcess.write.mockResolvedValue(undefined);

			await processService.write('session-1', '\n');

			expect(mockProcess.write).toHaveBeenCalledWith('session-1', '\n');
		});

		test('throws error and logs when write fails', async () => {
			const error = new Error('Write failed');
			mockProcess.write.mockRejectedValue(error);

			await expect(processService.write('session-1', 'data')).rejects.toThrow('Write failed');
			expect(console.error).toHaveBeenCalledWith('Process write error:', error);
		});

		test('handles special characters in data', async () => {
			mockProcess.write.mockResolvedValue(undefined);
			const specialData = '{"key": "value", "array": [1,2,3]}';

			await processService.write('session-1', specialData);

			expect(mockProcess.write).toHaveBeenCalledWith('session-1', specialData);
		});
	});

	describe('interrupt', () => {
		test('interrupts a process (sends SIGINT)', async () => {
			mockProcess.interrupt.mockResolvedValue(undefined);

			await processService.interrupt('session-1');

			expect(mockProcess.interrupt).toHaveBeenCalledWith('session-1');
			expect(mockProcess.interrupt).toHaveBeenCalledTimes(1);
		});

		test('interrupts multiple different sessions', async () => {
			mockProcess.interrupt.mockResolvedValue(undefined);

			await processService.interrupt('session-1');
			await processService.interrupt('session-2');

			expect(mockProcess.interrupt).toHaveBeenCalledTimes(2);
			expect(mockProcess.interrupt).toHaveBeenNthCalledWith(1, 'session-1');
			expect(mockProcess.interrupt).toHaveBeenNthCalledWith(2, 'session-2');
		});

		test('throws error and logs when interrupt fails', async () => {
			const error = new Error('Interrupt failed');
			mockProcess.interrupt.mockRejectedValue(error);

			await expect(processService.interrupt('session-1')).rejects.toThrow('Interrupt failed');
			expect(console.error).toHaveBeenCalledWith('Process interrupt error:', error);
		});

		test('handles interrupt on non-existent session', async () => {
			const error = new Error('Session not found');
			mockProcess.interrupt.mockRejectedValue(error);

			await expect(processService.interrupt('non-existent')).rejects.toThrow('Session not found');
		});
	});

	describe('kill', () => {
		test('kills a process', async () => {
			mockProcess.kill.mockResolvedValue(undefined);

			await processService.kill('session-1');

			expect(mockProcess.kill).toHaveBeenCalledWith('session-1');
			expect(mockProcess.kill).toHaveBeenCalledTimes(1);
		});

		test('kills multiple different sessions', async () => {
			mockProcess.kill.mockResolvedValue(undefined);

			await processService.kill('ai-session');
			await processService.kill('terminal-session');

			expect(mockProcess.kill).toHaveBeenCalledTimes(2);
			expect(mockProcess.kill).toHaveBeenNthCalledWith(1, 'ai-session');
			expect(mockProcess.kill).toHaveBeenNthCalledWith(2, 'terminal-session');
		});

		test('throws error and logs when kill fails', async () => {
			const error = new Error('Kill failed');
			mockProcess.kill.mockRejectedValue(error);

			await expect(processService.kill('session-1')).rejects.toThrow('Kill failed');
			expect(console.error).toHaveBeenCalledWith('Process kill error:', error);
		});

		test('handles kill on already-dead process', async () => {
			const error = new Error('Process already terminated');
			mockProcess.kill.mockRejectedValue(error);

			await expect(processService.kill('dead-session')).rejects.toThrow(
				'Process already terminated'
			);
		});
	});

	describe('resize', () => {
		test('resizes PTY terminal with specific dimensions', async () => {
			mockProcess.resize.mockResolvedValue(undefined);

			await processService.resize('session-1', 80, 24);

			expect(mockProcess.resize).toHaveBeenCalledWith('session-1', 80, 24);
			expect(mockProcess.resize).toHaveBeenCalledTimes(1);
		});

		test('resizes to different dimensions', async () => {
			mockProcess.resize.mockResolvedValue(undefined);

			await processService.resize('session-1', 120, 40);

			expect(mockProcess.resize).toHaveBeenCalledWith('session-1', 120, 40);
		});

		test('resizes to minimum dimensions', async () => {
			mockProcess.resize.mockResolvedValue(undefined);

			await processService.resize('session-1', 1, 1);

			expect(mockProcess.resize).toHaveBeenCalledWith('session-1', 1, 1);
		});

		test('resizes to large dimensions', async () => {
			mockProcess.resize.mockResolvedValue(undefined);

			await processService.resize('session-1', 300, 100);

			expect(mockProcess.resize).toHaveBeenCalledWith('session-1', 300, 100);
		});

		test('throws error and logs when resize fails', async () => {
			const error = new Error('Resize failed');
			mockProcess.resize.mockRejectedValue(error);

			await expect(processService.resize('session-1', 80, 24)).rejects.toThrow('Resize failed');
			expect(console.error).toHaveBeenCalledWith('Process resize error:', error);
		});

		test('handles resize for different sessions', async () => {
			mockProcess.resize.mockResolvedValue(undefined);

			await processService.resize('session-1', 80, 24);
			await processService.resize('session-2', 100, 30);

			expect(mockProcess.resize).toHaveBeenCalledTimes(2);
			expect(mockProcess.resize).toHaveBeenNthCalledWith(1, 'session-1', 80, 24);
			expect(mockProcess.resize).toHaveBeenNthCalledWith(2, 'session-2', 100, 30);
		});
	});

	describe('onData', () => {
		test('registers data handler and returns cleanup function', () => {
			const cleanup = vi.fn();
			mockProcess.onData.mockReturnValue(cleanup);
			const handler: ProcessDataHandler = vi.fn();

			const result = processService.onData(handler);

			expect(mockProcess.onData).toHaveBeenCalledWith(handler);
			expect(result).toBe(cleanup);
		});

		test('cleanup function can be called', () => {
			const cleanup = vi.fn();
			mockProcess.onData.mockReturnValue(cleanup);
			const handler: ProcessDataHandler = vi.fn();

			const result = processService.onData(handler);
			result();

			expect(cleanup).toHaveBeenCalled();
		});

		test('registers multiple data handlers', () => {
			const cleanup1 = vi.fn();
			const cleanup2 = vi.fn();
			mockProcess.onData.mockReturnValueOnce(cleanup1).mockReturnValueOnce(cleanup2);
			const handler1: ProcessDataHandler = vi.fn();
			const handler2: ProcessDataHandler = vi.fn();

			const result1 = processService.onData(handler1);
			const result2 = processService.onData(handler2);

			expect(mockProcess.onData).toHaveBeenCalledTimes(2);
			expect(result1).toBe(cleanup1);
			expect(result2).toBe(cleanup2);
		});

		test('handler receives sessionId and data', () => {
			const cleanup = vi.fn();
			mockProcess.onData.mockImplementation((handler: ProcessDataHandler) => {
				// Simulate calling the handler with test data
				handler('session-1', 'output data');
				return cleanup;
			});
			const handler: ProcessDataHandler = vi.fn();

			processService.onData(handler);

			expect(handler).toHaveBeenCalledWith('session-1', 'output data');
		});
	});

	describe('onExit', () => {
		test('registers exit handler and returns cleanup function', () => {
			const cleanup = vi.fn();
			mockProcess.onExit.mockReturnValue(cleanup);
			const handler: ProcessExitHandler = vi.fn();

			const result = processService.onExit(handler);

			expect(mockProcess.onExit).toHaveBeenCalledWith(handler);
			expect(result).toBe(cleanup);
		});

		test('cleanup function can be called', () => {
			const cleanup = vi.fn();
			mockProcess.onExit.mockReturnValue(cleanup);
			const handler: ProcessExitHandler = vi.fn();

			const result = processService.onExit(handler);
			result();

			expect(cleanup).toHaveBeenCalled();
		});

		test('registers multiple exit handlers', () => {
			const cleanup1 = vi.fn();
			const cleanup2 = vi.fn();
			mockProcess.onExit.mockReturnValueOnce(cleanup1).mockReturnValueOnce(cleanup2);
			const handler1: ProcessExitHandler = vi.fn();
			const handler2: ProcessExitHandler = vi.fn();

			const result1 = processService.onExit(handler1);
			const result2 = processService.onExit(handler2);

			expect(mockProcess.onExit).toHaveBeenCalledTimes(2);
			expect(result1).toBe(cleanup1);
			expect(result2).toBe(cleanup2);
		});

		test('handler receives sessionId and exit code', () => {
			const cleanup = vi.fn();
			mockProcess.onExit.mockImplementation((handler: ProcessExitHandler) => {
				// Simulate calling the handler with test data
				handler('session-1', 0);
				return cleanup;
			});
			const handler: ProcessExitHandler = vi.fn();

			processService.onExit(handler);

			expect(handler).toHaveBeenCalledWith('session-1', 0);
		});

		test('handler receives non-zero exit code', () => {
			const cleanup = vi.fn();
			mockProcess.onExit.mockImplementation((handler: ProcessExitHandler) => {
				handler('session-1', 1);
				return cleanup;
			});
			const handler: ProcessExitHandler = vi.fn();

			processService.onExit(handler);

			expect(handler).toHaveBeenCalledWith('session-1', 1);
		});
	});

	describe('onSessionId', () => {
		test('registers session-id handler and returns cleanup function', () => {
			const cleanup = vi.fn();
			mockProcess.onSessionId.mockReturnValue(cleanup);
			const handler: ProcessSessionIdHandler = vi.fn();

			const result = processService.onSessionId(handler);

			expect(mockProcess.onSessionId).toHaveBeenCalledWith(handler);
			expect(result).toBe(cleanup);
		});

		test('cleanup function can be called', () => {
			const cleanup = vi.fn();
			mockProcess.onSessionId.mockReturnValue(cleanup);
			const handler: ProcessSessionIdHandler = vi.fn();

			const result = processService.onSessionId(handler);
			result();

			expect(cleanup).toHaveBeenCalled();
		});

		test('registers multiple session-id handlers', () => {
			const cleanup1 = vi.fn();
			const cleanup2 = vi.fn();
			mockProcess.onSessionId.mockReturnValueOnce(cleanup1).mockReturnValueOnce(cleanup2);
			const handler1: ProcessSessionIdHandler = vi.fn();
			const handler2: ProcessSessionIdHandler = vi.fn();

			const result1 = processService.onSessionId(handler1);
			const result2 = processService.onSessionId(handler2);

			expect(mockProcess.onSessionId).toHaveBeenCalledTimes(2);
			expect(result1).toBe(cleanup1);
			expect(result2).toBe(cleanup2);
		});

		test('handler receives sessionId and agentSessionId', () => {
			const cleanup = vi.fn();
			mockProcess.onSessionId.mockImplementation((handler: ProcessSessionIdHandler) => {
				// Simulate calling the handler with test data
				handler('session-1', 'claude-abc123');
				return cleanup;
			});
			const handler: ProcessSessionIdHandler = vi.fn();

			processService.onSessionId(handler);

			expect(handler).toHaveBeenCalledWith('session-1', 'claude-abc123');
		});
	});

	describe('type exports', () => {
		test('ProcessConfig interface has required properties', () => {
			const config: ProcessConfig = {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/path',
				command: 'cmd',
				args: ['arg1'],
			};

			expect(config.sessionId).toBe('session-1');
			expect(config.toolType).toBe('claude-code');
			expect(config.cwd).toBe('/path');
			expect(config.command).toBe('cmd');
			expect(config.args).toEqual(['arg1']);
		});

		test('ProcessDataHandler type signature', () => {
			const handler: ProcessDataHandler = (sessionId: string, data: string) => {
				expect(typeof sessionId).toBe('string');
				expect(typeof data).toBe('string');
			};
			handler('session', 'data');
		});

		test('ProcessExitHandler type signature', () => {
			const handler: ProcessExitHandler = (sessionId: string, code: number) => {
				expect(typeof sessionId).toBe('string');
				expect(typeof code).toBe('number');
			};
			handler('session', 0);
		});

		test('ProcessSessionIdHandler type signature', () => {
			const handler: ProcessSessionIdHandler = (sessionId: string, agentSessionId: string) => {
				expect(typeof sessionId).toBe('string');
				expect(typeof agentSessionId).toBe('string');
			};
			handler('session', 'claude-id');
		});
	});
});
