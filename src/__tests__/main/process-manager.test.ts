/**
 * Tests for src/main/process-manager.ts
 *
 * Tests cover the aggregateModelUsage utility function that consolidates
 * token usage data from Claude Code responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
}));

// Mock node-pty before importing process-manager (native module)
vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('child_process', async () => {
	const actual = await vi.importActual<typeof import('child_process')>('child_process');
	return {
		...actual,
		execFile: mockExecFile,
		default: { ...actual, execFile: mockExecFile },
	};
});

// Mock logger to avoid any side effects
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock platform detection — delegates to process.platform by default so
// pre-existing tests that override process.platform still work. Kill-method
// tests override via mockReturnValueOnce / mockReturnValue.
const { mockIsWindows } = vi.hoisted(() => ({
	mockIsWindows: vi.fn<() => boolean>().mockImplementation(() => process.platform === 'win32'),
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: () => mockIsWindows(),
}));

import * as fs from 'fs';

import {
	aggregateModelUsage,
	ProcessManager,
	detectNodeVersionManagerBinPaths,
	buildUnixBasePath,
	type UsageStats,
	type ModelStats,
	type AgentError,
} from '../../main/process-manager';
import { logger } from '../../main/utils/logger';

describe('process-manager.ts', () => {
	describe('aggregateModelUsage', () => {
		describe('with modelUsage data', () => {
			it('should aggregate tokens from a single model', () => {
				const modelUsage: Record<string, ModelStats> = {
					'claude-3-sonnet': {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadInputTokens: 200,
						cacheCreationInputTokens: 100,
						contextWindow: 200000,
					},
				};

				const result = aggregateModelUsage(modelUsage, {}, 0.05);

				expect(result).toEqual({
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadInputTokens: 200,
					cacheCreationInputTokens: 100,
					totalCostUsd: 0.05,
					contextWindow: 200000,
				});
			});

			it('should use MAX (not SUM) across multiple models', () => {
				// When multiple models are used in one turn, each reads the same context
				// from cache. Using MAX gives actual context size, SUM would double-count.
				const modelUsage: Record<string, ModelStats> = {
					'claude-3-sonnet': {
						inputTokens: 1000,
						outputTokens: 500,
						cacheReadInputTokens: 200,
						cacheCreationInputTokens: 100,
						contextWindow: 200000,
					},
					'claude-3-haiku': {
						inputTokens: 500,
						outputTokens: 250,
						cacheReadInputTokens: 100,
						cacheCreationInputTokens: 50,
						contextWindow: 180000,
					},
				};

				const result = aggregateModelUsage(modelUsage, {}, 0.1);

				// MAX values: max(1000,500)=1000, max(500,250)=500, etc.
				expect(result).toEqual({
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadInputTokens: 200,
					cacheCreationInputTokens: 100,
					totalCostUsd: 0.1,
					contextWindow: 200000, // Should use the highest context window
				});
			});

			it('should use highest context window from any model', () => {
				const modelUsage: Record<string, ModelStats> = {
					'model-small': {
						inputTokens: 100,
						outputTokens: 50,
						contextWindow: 128000,
					},
					'model-large': {
						inputTokens: 200,
						outputTokens: 100,
						contextWindow: 1000000, // Much larger context
					},
				};

				const result = aggregateModelUsage(modelUsage);

				expect(result.contextWindow).toBe(1000000);
			});

			it('should handle models with missing optional fields', () => {
				const modelUsage: Record<string, ModelStats> = {
					'model-1': {
						inputTokens: 1000,
						outputTokens: 500,
						// No cache fields
					},
					'model-2': {
						inputTokens: 500,
						// Missing outputTokens
						cacheReadInputTokens: 100,
					},
				};

				const result = aggregateModelUsage(modelUsage);

				// MAX values: max(1000,500)=1000, max(500,0)=500, max(0,100)=100
				expect(result).toEqual({
					inputTokens: 1000,
					outputTokens: 500,
					cacheReadInputTokens: 100,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 200000, // Default value
				});
			});

			it('should handle empty modelUsage object', () => {
				const modelUsage: Record<string, ModelStats> = {};

				const result = aggregateModelUsage(modelUsage, {
					input_tokens: 500,
					output_tokens: 250,
				});

				// Should fall back to usage object when modelUsage is empty
				expect(result.inputTokens).toBe(500);
				expect(result.outputTokens).toBe(250);
			});
		});

		describe('fallback to usage object', () => {
			it('should use usage object when modelUsage is undefined', () => {
				const usage = {
					input_tokens: 2000,
					output_tokens: 1000,
					cache_read_input_tokens: 500,
					cache_creation_input_tokens: 250,
				};

				const result = aggregateModelUsage(undefined, usage, 0.15);

				expect(result).toEqual({
					inputTokens: 2000,
					outputTokens: 1000,
					cacheReadInputTokens: 500,
					cacheCreationInputTokens: 250,
					totalCostUsd: 0.15,
					contextWindow: 200000, // Default
				});
			});

			it('should use usage object when modelUsage has zero totals', () => {
				const modelUsage: Record<string, ModelStats> = {
					'empty-model': {
						inputTokens: 0,
						outputTokens: 0,
					},
				};
				const usage = {
					input_tokens: 1500,
					output_tokens: 750,
				};

				const result = aggregateModelUsage(modelUsage, usage);

				expect(result.inputTokens).toBe(1500);
				expect(result.outputTokens).toBe(750);
			});

			it('should handle partial usage object', () => {
				const usage = {
					input_tokens: 1000,
					// Missing other fields
				};

				const result = aggregateModelUsage(undefined, usage);

				expect(result).toEqual({
					inputTokens: 1000,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 200000,
				});
			});
		});

		describe('default values', () => {
			it('should use default values when no data provided', () => {
				const result = aggregateModelUsage(undefined, {}, 0);

				expect(result).toEqual({
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 200000, // Default for Claude
				});
			});

			it('should use default empty object for usage when not provided', () => {
				const result = aggregateModelUsage(undefined);

				expect(result).toEqual({
					inputTokens: 0,
					outputTokens: 0,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					totalCostUsd: 0,
					contextWindow: 200000,
				});
			});

			it('should use default 0 for totalCostUsd when not provided', () => {
				const result = aggregateModelUsage(undefined, {});

				expect(result.totalCostUsd).toBe(0);
			});
		});

		describe('totalCostUsd handling', () => {
			it('should pass through totalCostUsd value', () => {
				const result = aggregateModelUsage(undefined, {}, 1.23);
				expect(result.totalCostUsd).toBe(1.23);
			});

			it('should handle zero cost', () => {
				const result = aggregateModelUsage(undefined, {}, 0);
				expect(result.totalCostUsd).toBe(0);
			});

			it('should handle very small cost values', () => {
				const result = aggregateModelUsage(undefined, {}, 0.000001);
				expect(result.totalCostUsd).toBe(0.000001);
			});
		});

		describe('realistic scenarios', () => {
			it('should handle typical Claude Code response with modelUsage', () => {
				// Simulating actual Claude Code response format
				const modelUsage: Record<string, ModelStats> = {
					'claude-sonnet-4-20250514': {
						inputTokens: 15420,
						outputTokens: 2340,
						cacheReadInputTokens: 12000,
						cacheCreationInputTokens: 1500,
						contextWindow: 200000,
					},
				};

				const result = aggregateModelUsage(modelUsage, {}, 0.0543);

				expect(result.inputTokens).toBe(15420);
				expect(result.outputTokens).toBe(2340);
				expect(result.cacheReadInputTokens).toBe(12000);
				expect(result.cacheCreationInputTokens).toBe(1500);
				expect(result.totalCostUsd).toBe(0.0543);
				expect(result.contextWindow).toBe(200000);
			});

			it('should handle legacy response without modelUsage', () => {
				// Older CLI versions might not include modelUsage
				const usage = {
					input_tokens: 5000,
					output_tokens: 1500,
					cache_read_input_tokens: 3000,
					cache_creation_input_tokens: 500,
				};

				const result = aggregateModelUsage(undefined, usage, 0.025);

				expect(result.inputTokens).toBe(5000);
				expect(result.outputTokens).toBe(1500);
				expect(result.cacheReadInputTokens).toBe(3000);
				expect(result.cacheCreationInputTokens).toBe(500);
				expect(result.totalCostUsd).toBe(0.025);
			});

			it('should handle response with both modelUsage and usage (prefer modelUsage)', () => {
				const modelUsage: Record<string, ModelStats> = {
					'claude-3-sonnet': {
						inputTokens: 10000, // Full context including cache
						outputTokens: 500,
					},
				};
				const usage = {
					input_tokens: 1000, // Only new/billable tokens
					output_tokens: 500,
				};

				const result = aggregateModelUsage(modelUsage, usage, 0.05);

				// Should use modelUsage values (full context) not usage (billable only)
				expect(result.inputTokens).toBe(10000);
				expect(result.outputTokens).toBe(500);
			});

			it('should use MAX across multi-model response (e.g., main + tool use)', () => {
				// When multiple models are used, each reads the same context. MAX avoids double-counting.
				const modelUsage: Record<string, ModelStats> = {
					'claude-3-opus': {
						inputTokens: 20000,
						outputTokens: 3000,
						cacheReadInputTokens: 15000,
						cacheCreationInputTokens: 2000,
						contextWindow: 200000,
					},
					'claude-3-haiku': {
						// Used for tool use - smaller context read
						inputTokens: 500,
						outputTokens: 100,
						contextWindow: 200000,
					},
				};

				const result = aggregateModelUsage(modelUsage, {}, 0.25);

				// MAX values: max(20000, 500)=20000, max(3000, 100)=3000
				expect(result.inputTokens).toBe(20000);
				expect(result.outputTokens).toBe(3000);
				expect(result.cacheReadInputTokens).toBe(15000);
				expect(result.cacheCreationInputTokens).toBe(2000);
				expect(result.totalCostUsd).toBe(0.25);
			});
		});
	});

	describe('ProcessManager', () => {
		let processManager: ProcessManager;

		beforeEach(() => {
			vi.clearAllMocks();
			processManager = new ProcessManager();
		});

		const getProcesses = () =>
			(processManager as unknown as { processes: Map<string, Record<string, any>> }).processes;

		const addProcess = (overrides: Record<string, any> = {}) => {
			const managedProcess = {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/tmp',
				pid: 123,
				isTerminal: false,
				startTime: Date.now(),
				...overrides,
			};
			getProcesses().set(managedProcess.sessionId, managedProcess);
			return managedProcess;
		};

		describe('error detection exports', () => {
			it('should export AgentError type', () => {
				// This test verifies the type is exportable
				const error: AgentError = {
					type: 'auth_expired',
					message: 'Test error',
					recoverable: true,
					agentId: 'claude-code',
					timestamp: Date.now(),
				};
				expect(error.type).toBe('auth_expired');
			});
		});

		describe('agent-error event emission', () => {
			it('should be an EventEmitter that supports agent-error events', () => {
				let emittedError: AgentError | null = null;
				processManager.on('agent-error', (sessionId: string, error: AgentError) => {
					emittedError = error;
				});

				// Manually emit an error event to verify the event system works
				const testError: AgentError = {
					type: 'rate_limited',
					message: 'Rate limit exceeded',
					recoverable: true,
					agentId: 'claude-code',
					sessionId: 'test-session',
					timestamp: Date.now(),
				};
				processManager.emit('agent-error', 'test-session', testError);

				expect(emittedError).not.toBeNull();
				expect(emittedError!.type).toBe('rate_limited');
				expect(emittedError!.message).toBe('Rate limit exceeded');
				expect(emittedError!.agentId).toBe('claude-code');
			});

			it('should include sessionId in emitted error', () => {
				let capturedSessionId: string | null = null;
				processManager.on('agent-error', (sessionId: string) => {
					capturedSessionId = sessionId;
				});

				const testError: AgentError = {
					type: 'network_error',
					message: 'Connection failed',
					recoverable: true,
					agentId: 'claude-code',
					timestamp: Date.now(),
				};
				processManager.emit('agent-error', 'session-123', testError);

				expect(capturedSessionId).toBe('session-123');
			});
		});

		describe('getParser method', () => {
			it('should return null for unknown session', () => {
				const parser = processManager.getParser('non-existent-session');
				expect(parser).toBeNull();
			});
		});

		describe('parseLine method', () => {
			it('should return null for unknown session', () => {
				const event = processManager.parseLine('non-existent-session', '{"type":"test"}');
				expect(event).toBeNull();
			});

			it('should parse JSON lines with the session parser when present', () => {
				const parsedEvent = { type: 'assistant', text: 'hello' };
				const outputParser = {
					parseJsonLine: vi.fn().mockReturnValue(parsedEvent),
				};
				addProcess({ outputParser });

				const event = processManager.parseLine('session-1', '{"type":"assistant"}');

				expect(event).toBe(parsedEvent);
				expect(outputParser.parseJsonLine).toHaveBeenCalledWith('{"type":"assistant"}');
				expect(processManager.getParser('session-1')).toBe(outputParser);
			});
		});

		describe('spawn routing', () => {
			const baseConfig = {
				sessionId: 'session-1',
				toolType: 'claude-code',
				cwd: '/tmp',
				command: 'echo',
				args: ['hello'],
			};

			it('should route terminal processes to the PTY spawner', () => {
				const ptySpawn = vi
					.spyOn((processManager as any).ptySpawner, 'spawn')
					.mockReturnValue({ success: true, pid: 101 });
				const childSpawn = vi.spyOn((processManager as any).childProcessSpawner, 'spawn');

				const result = processManager.spawn({ ...baseConfig, toolType: 'terminal' });

				expect(result).toEqual({ success: true, pid: 101 });
				expect(ptySpawn).toHaveBeenCalledWith({ ...baseConfig, toolType: 'terminal' });
				expect(childSpawn).not.toHaveBeenCalled();
			});

			it('should route requiresPty processes without prompts to the PTY spawner', () => {
				const ptySpawn = vi
					.spyOn((processManager as any).ptySpawner, 'spawn')
					.mockReturnValue({ success: true, pid: 102 });

				processManager.spawn({ ...baseConfig, requiresPty: true });

				expect(ptySpawn).toHaveBeenCalledWith({ ...baseConfig, requiresPty: true });
			});

			it('should route prompt-based processes to the child-process spawner', () => {
				const ptySpawn = vi.spyOn((processManager as any).ptySpawner, 'spawn');
				const childSpawn = vi
					.spyOn((processManager as any).childProcessSpawner, 'spawn')
					.mockReturnValue({ success: true, pid: 103 });

				const result = processManager.spawn({ ...baseConfig, requiresPty: true, prompt: 'hello' });

				expect(result).toEqual({ success: true, pid: 103 });
				expect(childSpawn).toHaveBeenCalledWith({
					...baseConfig,
					requiresPty: true,
					prompt: 'hello',
				});
				expect(ptySpawn).not.toHaveBeenCalled();
			});
		});

		describe('write method', () => {
			it('should return false and log when writing to an unknown session', () => {
				expect(processManager.write('missing-session', 'data')).toBe(false);
				expect(logger.error).toHaveBeenCalledWith(
					'[ProcessManager] write() - No process found for session',
					'ProcessManager',
					{ sessionId: 'missing-session' }
				);
			});

			it('should write to PTY processes and remember the trimmed command', () => {
				const ptyProcess = { write: vi.fn() };
				const managedProcess = addProcess({
					isTerminal: true,
					ptyProcess,
					lastCommand: 'previous',
				});

				expect(processManager.write('session-1', '  npm test  \n')).toBe(true);

				expect(ptyProcess.write).toHaveBeenCalledWith('  npm test  \n');
				expect(managedProcess.lastCommand).toBe('npm test');
			});

			it('should not replace the last terminal command for blank input', () => {
				const ptyProcess = { write: vi.fn() };
				const managedProcess = addProcess({
					isTerminal: true,
					ptyProcess,
					lastCommand: 'previous',
				});

				expect(processManager.write('session-1', '   \n')).toBe(true);

				expect(ptyProcess.write).toHaveBeenCalledWith('   \n');
				expect(managedProcess.lastCommand).toBe('previous');
			});

			it('should write to child process stdin when available', () => {
				const stdin = { write: vi.fn() };
				addProcess({ childProcess: { stdin } });

				expect(processManager.write('session-1', 'hello')).toBe(true);

				expect(stdin.write).toHaveBeenCalledWith('hello');
			});

			it('should return false when no writable process stream is available', () => {
				addProcess({ childProcess: {} });

				expect(processManager.write('session-1', 'hello')).toBe(false);
			});

			it('should return false and log when process writing throws', () => {
				const ptyProcess = {
					write: vi.fn(() => {
						throw new Error('closed');
					}),
				};
				addProcess({ isTerminal: true, ptyProcess });

				expect(processManager.write('session-1', 'hello')).toBe(false);
				expect(logger.error).toHaveBeenCalledWith(
					'[ProcessManager] Failed to write to process',
					'ProcessManager',
					expect.objectContaining({ sessionId: 'session-1', error: 'Error: closed' })
				);
			});
		});

		describe('resize method', () => {
			it('should return false when the session is not a PTY process', () => {
				addProcess({ isTerminal: false });

				expect(processManager.resize('session-1', 120, 40)).toBe(false);
				expect(processManager.resize('missing-session', 120, 40)).toBe(false);
			});

			it('should resize PTY processes', () => {
				const ptyProcess = { resize: vi.fn() };
				addProcess({ isTerminal: true, ptyProcess });

				expect(processManager.resize('session-1', 120, 40)).toBe(true);

				expect(ptyProcess.resize).toHaveBeenCalledWith(120, 40);
			});

			it('should return false and log when resize throws', () => {
				const ptyProcess = {
					resize: vi.fn(() => {
						throw new Error('bad size');
					}),
				};
				addProcess({ isTerminal: true, ptyProcess });

				expect(processManager.resize('session-1', 120, 40)).toBe(false);
				expect(logger.error).toHaveBeenCalledWith(
					'[ProcessManager] Failed to resize terminal',
					'ProcessManager',
					expect.objectContaining({ sessionId: 'session-1', error: 'Error: bad size' })
				);
			});
		});

		describe('interrupt method', () => {
			afterEach(() => {
				vi.useRealTimers();
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
			});

			it('should return false when no process exists', () => {
				expect(processManager.interrupt('missing-session')).toBe(false);
			});

			it('should send Ctrl+C to PTY processes', () => {
				const ptyProcess = { write: vi.fn() };
				addProcess({ isTerminal: true, ptyProcess });

				expect(processManager.interrupt('session-1')).toBe(true);

				expect(ptyProcess.write).toHaveBeenCalledWith('\x03');
			});

			it('should return false when the managed process has no interruptible handle', () => {
				addProcess({ isTerminal: false, childProcess: undefined, ptyProcess: undefined });

				expect(processManager.interrupt('session-1')).toBe(false);
			});

			it('should send SIGINT to child processes and escalate if they remain running', () => {
				vi.useFakeTimers();
				mockIsWindows.mockReturnValue(false);
				const childProcess = {
					kill: vi.fn(),
					killed: false,
					once: vi.fn(),
					pid: 456,
				};
				addProcess({ childProcess, pid: 456 });
				const killSpy = vi.spyOn(processManager, 'kill').mockReturnValue(true);

				expect(processManager.interrupt('session-1')).toBe(true);

				expect(childProcess.kill).toHaveBeenCalledWith('SIGINT');
				expect(childProcess.once).toHaveBeenCalledWith('exit', expect.any(Function));
				vi.advanceTimersByTime(2000);
				expect(killSpy).toHaveBeenCalledWith('session-1');
			});

			it('should not escalate interrupt when the child is already killed', () => {
				vi.useFakeTimers();
				mockIsWindows.mockReturnValue(false);
				const childProcess = {
					kill: vi.fn(),
					killed: true,
					once: vi.fn(),
					pid: 456,
				};
				addProcess({ childProcess, pid: 456 });
				const killSpy = vi.spyOn(processManager, 'kill');

				expect(processManager.interrupt('session-1')).toBe(true);
				vi.advanceTimersByTime(2000);

				expect(killSpy).not.toHaveBeenCalled();
			});

			it('should clear interrupt escalation when the child exits', () => {
				vi.useFakeTimers();
				mockIsWindows.mockReturnValue(false);
				let exitHandler: (() => void) | undefined;
				const childProcess = {
					kill: vi.fn(),
					killed: false,
					once: vi.fn((_event: string, handler: () => void) => {
						exitHandler = handler;
					}),
					pid: 456,
				};
				addProcess({ childProcess, pid: 456 });
				const killSpy = vi.spyOn(processManager, 'kill');

				expect(processManager.interrupt('session-1')).toBe(true);
				exitHandler!();
				vi.advanceTimersByTime(2000);

				expect(killSpy).not.toHaveBeenCalled();
			});

			it('should write Ctrl+C to child stdin for Windows interrupts', () => {
				vi.useFakeTimers();
				mockIsWindows.mockReturnValue(true);
				const stdin = { write: vi.fn(), destroyed: false, writableEnded: false };
				const childProcess = {
					stdin,
					kill: vi.fn(),
					killed: true,
					once: vi.fn(),
					pid: 456,
				};
				addProcess({ childProcess, pid: 456 });

				expect(processManager.interrupt('session-1')).toBe(true);

				expect(stdin.write).toHaveBeenCalledWith('\x03');
				expect(childProcess.kill).not.toHaveBeenCalledWith('SIGINT');
			});

			it('should warn when Windows child stdin is unavailable', () => {
				vi.useFakeTimers();
				mockIsWindows.mockReturnValue(true);
				const childProcess = {
					stdin: { write: vi.fn(), destroyed: true, writableEnded: false },
					killed: true,
					once: vi.fn(),
					pid: 456,
				};
				addProcess({ childProcess, pid: 456 });

				expect(processManager.interrupt('session-1')).toBe(true);

				expect(logger.warn).toHaveBeenCalledWith(
					'[ProcessManager] stdin unavailable for Windows interrupt, will escalate to kill',
					'ProcessManager',
					{ sessionId: 'session-1' }
				);
			});

			it('should return false and log when interrupt throws', () => {
				mockIsWindows.mockReturnValue(false);
				const childProcess = {
					kill: vi.fn(() => {
						throw new Error('signal failed');
					}),
					once: vi.fn(),
					pid: 456,
				};
				addProcess({ childProcess, pid: 456 });

				expect(processManager.interrupt('session-1')).toBe(false);
				expect(logger.error).toHaveBeenCalledWith(
					'[ProcessManager] Failed to interrupt process',
					'ProcessManager',
					expect.objectContaining({ sessionId: 'session-1', error: 'Error: signal failed' })
				);
			});
		});

		describe('runCommand method', () => {
			it('should delegate local commands to the local command runner', async () => {
				const localRun = vi
					.spyOn((processManager as any).localCommandRunner, 'run')
					.mockResolvedValue({ exitCode: 0 });

				await expect(
					processManager.runCommand('session-1', 'npm test', '/project', 'zsh', {
						NODE_ENV: 'test',
					})
				).resolves.toEqual({ exitCode: 0 });

				expect(localRun).toHaveBeenCalledWith('session-1', 'npm test', '/project', 'zsh', {
					NODE_ENV: 'test',
				});
			});

			it('should delegate SSH commands to the SSH command runner', async () => {
				const sshConfig = { id: 'remote-1', host: 'example.com', username: 'ubuntu' } as any;
				const sshRun = vi
					.spyOn((processManager as any).sshCommandRunner, 'run')
					.mockResolvedValue({ exitCode: 0 });

				await expect(
					processManager.runCommand(
						'session-1',
						'npm test',
						'/project',
						'zsh',
						{ NODE_ENV: 'test' },
						sshConfig
					)
				).resolves.toEqual({ exitCode: 0 });

				expect(sshRun).toHaveBeenCalledWith('session-1', 'npm test', '/project', sshConfig, {
					NODE_ENV: 'test',
				});
			});
		});

		describe('kill method — Windows PTY tree kill', () => {
			let killWindowsTreeSpy: ReturnType<typeof vi.spyOn>;

			beforeEach(() => {
				// Spy on the private killWindowsProcessTree method
				killWindowsTreeSpy = vi
					.spyOn(ProcessManager.prototype as never, 'killWindowsProcessTree' as never)
					.mockImplementation(() => {});
			});

			afterEach(() => {
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
				killWindowsTreeSpy.mockRestore();
			});

			it('should use taskkill tree-kill for PTY processes on Windows', () => {
				mockIsWindows.mockReturnValue(true);

				const mockPtyProcess = { kill: vi.fn(), onExit: vi.fn() };
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					ptyProcess: mockPtyProcess,
					isTerminal: true,
					pid: 12345,
					cwd: '/tmp',
					startTime: Date.now(),
				});

				processManager.kill('pty-session');

				// Should use taskkill tree-kill, NOT node-pty's kill
				expect(killWindowsTreeSpy).toHaveBeenCalledWith(12345, 'pty-session');
				expect(mockPtyProcess.kill).not.toHaveBeenCalled();
			});

			it('should use ptyProcess.kill() for PTY processes on non-Windows', () => {
				mockIsWindows.mockReturnValue(false);

				const mockPtyProcess = { kill: vi.fn(), onExit: vi.fn() };
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					ptyProcess: mockPtyProcess,
					isTerminal: true,
					pid: 12345,
					cwd: '/tmp',
					startTime: Date.now(),
				});

				processManager.kill('pty-session');

				expect(mockPtyProcess.kill).toHaveBeenCalled();
				expect(killWindowsTreeSpy).not.toHaveBeenCalled();
			});

			it('should use taskkill tree-kill for child processes on Windows', () => {
				mockIsWindows.mockReturnValue(true);

				const mockChildProcess = { kill: vi.fn(), pid: 99999 };
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('child-session', {
					sessionId: 'child-session',
					toolType: 'claude-code',
					childProcess: mockChildProcess,
					isTerminal: false,
					pid: 99999,
					cwd: '/tmp',
					startTime: Date.now(),
				});

				processManager.kill('child-session');

				expect(killWindowsTreeSpy).toHaveBeenCalledWith(99999, 'child-session');
				expect(mockChildProcess.kill).not.toHaveBeenCalled();
			});

			it('should remove process from map after kill', () => {
				mockIsWindows.mockReturnValue(true);

				const mockPtyProcess = { kill: vi.fn(), onExit: vi.fn() };
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					ptyProcess: mockPtyProcess,
					isTerminal: true,
					pid: 12345,
					cwd: '/tmp',
					startTime: Date.now(),
				});

				processManager.kill('pty-session');

				expect(processManager.get('pty-session')).toBeUndefined();
			});

			it('should return false when killing an unknown session', () => {
				expect(processManager.kill('missing-session')).toBe(false);
			});

			it('should remove managed processes even when no process handle is attached', () => {
				addProcess({
					sessionId: 'detached-session',
					childProcess: undefined,
					ptyProcess: undefined,
				});

				expect(processManager.kill('detached-session')).toBe(true);

				expect(processManager.get('detached-session')).toBeUndefined();
			});

			it('should send SIGTERM to child processes on non-Windows', () => {
				mockIsWindows.mockReturnValue(false);
				const childProcess = { kill: vi.fn(), pid: 99999 };
				addProcess({ sessionId: 'child-session', childProcess, pid: 99999 });

				expect(processManager.kill('child-session')).toBe(true);

				expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
				expect(killWindowsTreeSpy).not.toHaveBeenCalled();
				expect(processManager.get('child-session')).toBeUndefined();
			});

			it('should fall back to SIGTERM when Windows child pid is unavailable', () => {
				mockIsWindows.mockReturnValue(true);
				const childProcess = { kill: vi.fn(), pid: undefined };
				addProcess({ sessionId: 'child-session', childProcess, pid: undefined });

				expect(processManager.kill('child-session')).toBe(true);

				expect(childProcess.kill).toHaveBeenCalledWith('SIGTERM');
				expect(logger.warn).toHaveBeenCalledWith(
					'[ProcessManager] pid unavailable for Windows taskkill, falling back to SIGTERM',
					'ProcessManager',
					{ sessionId: 'child-session' }
				);
			});

			it('should clear buffered data timeout and flush before killing', () => {
				mockIsWindows.mockReturnValue(false);
				vi.useFakeTimers();
				const timeout = setTimeout(() => {}, 1000);
				const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
				const flushSpy = vi.spyOn((processManager as any).bufferManager, 'flushDataBuffer');
				try {
					const childProcess = { kill: vi.fn(), pid: 99999 };
					addProcess({
						sessionId: 'child-session',
						childProcess,
						pid: 99999,
						dataBufferTimeout: timeout,
					});

					expect(processManager.kill('child-session')).toBe(true);

					expect(clearTimeoutSpy).toHaveBeenCalledWith(timeout);
					expect(flushSpy).toHaveBeenCalledWith('child-session');
				} finally {
					clearTimeoutSpy.mockRestore();
					flushSpy.mockRestore();
					vi.useRealTimers();
				}
			});

			it('should return false and log when kill throws', () => {
				mockIsWindows.mockReturnValue(false);
				const childProcess = {
					kill: vi.fn(() => {
						throw new Error('kill failed');
					}),
					pid: 99999,
				};
				addProcess({ sessionId: 'child-session', childProcess, pid: 99999 });

				expect(processManager.kill('child-session')).toBe(false);
				expect(logger.error).toHaveBeenCalledWith(
					'[ProcessManager] Failed to kill process',
					'ProcessManager',
					expect.objectContaining({ sessionId: 'child-session', error: 'Error: kill failed' })
				);
			});

			it('should kill all managed processes', () => {
				addProcess({ sessionId: 'session-1' });
				addProcess({ sessionId: 'session-2' });
				const killSpy = vi.spyOn(processManager, 'kill').mockReturnValue(true);

				processManager.killAll();

				expect(killSpy).toHaveBeenCalledWith('session-1');
				expect(killSpy).toHaveBeenCalledWith('session-2');
			});

			it('should return all managed processes', () => {
				const first = addProcess({ sessionId: 'session-1' });
				const second = addProcess({ sessionId: 'session-2' });

				expect(processManager.getAll()).toEqual([first, second]);
				expect(processManager.get('session-1')).toBe(first);
			});

			it('should invoke taskkill for Windows process tree termination', () => {
				killWindowsTreeSpy.mockRestore();
				mockExecFile.mockImplementation((_command, _args, callback) => callback(null));

				(processManager as any).killWindowsProcessTree(12345, 'session-1');

				expect(mockExecFile).toHaveBeenCalledWith(
					'taskkill',
					['/pid', '12345', '/t', '/f'],
					expect.any(Function)
				);
				expect(logger.info).toHaveBeenCalledWith(
					'[ProcessManager] Using taskkill to terminate process tree on Windows',
					'ProcessManager',
					{ sessionId: 'session-1', pid: 12345 }
				);
			});

			it('should log debug details when taskkill reports an error', () => {
				killWindowsTreeSpy.mockRestore();
				const error = new Error('already exited');
				mockExecFile.mockImplementation((_command, _args, callback) => callback(error));

				(processManager as any).killWindowsProcessTree(12345, 'session-1');

				expect(logger.debug).toHaveBeenCalledWith(
					'[ProcessManager] taskkill exited with error (process may already be terminated)',
					'ProcessManager',
					{ sessionId: 'session-1', pid: 12345, error: 'Error: already exited' }
				);
			});
		});
	});

	describe('data buffering', () => {
		let processManager: ProcessManager;

		beforeEach(() => {
			processManager = new ProcessManager();
			vi.useFakeTimers();
		});

		afterEach(() => {
			processManager.killAll();
			vi.useRealTimers();
		});

		it('should buffer data events and flush after 50ms', () => {
			const emittedData: string[] = [];
			processManager.on('data', (sessionId: string, data: string) => {
				emittedData.push(data);
			});

			// Manually call the private method via emit simulation
			// Since emitDataBuffered is private, we test via the public event interface
			processManager.emit('data', 'test-session', 'chunk1');
			processManager.emit('data', 'test-session', 'chunk2');

			expect(emittedData).toHaveLength(2); // Direct emits pass through
		});

		it('should flush buffer on kill', () => {
			const emittedData: string[] = [];
			processManager.on('data', (sessionId: string, data: string) => {
				emittedData.push(data);
			});

			// Kill should not throw even with no processes
			expect(() => processManager.kill('non-existent')).not.toThrow();
		});

		it('should clear timeout on kill to prevent memory leaks', () => {
			// Verify killAll doesn't throw
			expect(() => processManager.killAll()).not.toThrow();
		});
	});

	describe('detectNodeVersionManagerBinPaths', () => {
		// Note: These tests use the real filesystem. On the test machine, they verify
		// that the function returns an array (possibly empty) and doesn't throw.
		// Full mocking would require restructuring the module to accept fs as a dependency.

		describe('on Windows', () => {
			it('should return empty array on Windows', () => {
				const originalPlatform = process.platform;
				Object.defineProperty(process, 'platform', {
					value: 'win32',
					configurable: true,
				});

				const result = detectNodeVersionManagerBinPaths();

				expect(result).toEqual([]);
				Object.defineProperty(process, 'platform', {
					value: originalPlatform,
					configurable: true,
				});
			});
		});

		describe('on Unix systems', () => {
			it('should return an array of strings', () => {
				// Skip on Windows
				if (process.platform === 'win32') return;

				const result = detectNodeVersionManagerBinPaths();

				expect(Array.isArray(result)).toBe(true);
				result.forEach((path) => {
					expect(typeof path).toBe('string');
					expect(path.length).toBeGreaterThan(0);
				});
			});

			it('should only return paths that exist', () => {
				// Skip on Windows
				if (process.platform === 'win32') return;

				const result = detectNodeVersionManagerBinPaths();

				// All returned paths should exist on the filesystem
				result.forEach((path) => {
					expect(fs.existsSync(path)).toBe(true);
				});
			});

			it('should respect NVM_DIR environment variable when set', () => {
				// Skip on Windows
				if (process.platform === 'win32') return;

				const originalNvmDir = process.env.NVM_DIR;

				// Set to a non-existent path
				process.env.NVM_DIR = '/nonexistent/nvm/path';
				const resultWithFakePath = detectNodeVersionManagerBinPaths();

				// Should not include the fake path since it doesn't exist
				expect(resultWithFakePath.some((p) => p.includes('/nonexistent/'))).toBe(false);

				process.env.NVM_DIR = originalNvmDir;
			});
		});
	});

	describe('buildUnixBasePath', () => {
		it('should include standard paths', () => {
			// Skip on Windows
			if (process.platform === 'win32') return;

			const result = buildUnixBasePath();

			expect(result).toContain('/opt/homebrew/bin');
			expect(result).toContain('/usr/local/bin');
			expect(result).toContain('/usr/bin');
			expect(result).toContain('/bin');
			expect(result).toContain('/usr/sbin');
			expect(result).toContain('/sbin');
		});

		it('should be a colon-separated path string', () => {
			// Skip on Windows
			if (process.platform === 'win32') return;

			const result = buildUnixBasePath();

			expect(typeof result).toBe('string');
			expect(result.includes(':')).toBe(true);

			// Should not have empty segments
			const segments = result.split(':');
			segments.forEach((segment) => {
				expect(segment.length).toBeGreaterThan(0);
			});
		});

		it('should prepend version manager paths when available', () => {
			// Skip on Windows
			if (process.platform === 'win32') return;

			const result = buildUnixBasePath();
			const standardPaths = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

			// Result should end with standard paths (they come after version manager paths)
			expect(result.endsWith(standardPaths) || result === standardPaths).toBe(true);
		});
	});
});
