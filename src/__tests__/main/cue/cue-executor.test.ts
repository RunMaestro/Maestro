/**
 * Tests for the Cue executor module.
 *
 * Tests cover:
 * - Prompt file resolution (absolute and relative paths)
 * - Prompt file read failures
 * - Template variable substitution with Cue event context
 * - Agent argument building (follows process:spawn pattern)
 * - Process spawning and stdout/stderr capture
 * - Timeout enforcement with SIGTERM → SIGKILL escalation
 * - Successful completion and failure detection
 * - SSH remote execution wrapping
 * - stopCueRun process termination
 * - recordCueHistoryEntry construction
 * - History entry field population and response truncation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { CueEvent, CueSubscription, CueRunResult } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

// --- Mocks ---

// Mock fs
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
	readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

// Mock crypto
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

// Mock substituteTemplateVariables
const mockSubstitute = vi.fn((template: string) => `substituted: ${template}`);
vi.mock('../../../shared/templateVariables', () => ({
	substituteTemplateVariables: (...args: unknown[]) => mockSubstitute(args[0] as string, args[1]),
}));

// Mock agents module
const mockGetAgentDefinition = vi.fn();
const mockGetAgentCapabilities = vi.fn(() => ({
	supportsResume: true,
	supportsReadOnlyMode: true,
	supportsJsonOutput: true,
	supportsSessionId: true,
	supportsImageInput: false,
	supportsImageInputOnResume: false,
	supportsSlashCommands: true,
	supportsSessionStorage: true,
	supportsCostTracking: true,
	supportsContextUsage: true,
	supportsThinking: false,
	supportsStdin: false,
	supportsRawStdin: false,
	supportsModelSelection: false,
	supportsModelDiscovery: false,
	supportsBatchMode: true,
	supportsYoloMode: true,
	supportsExitCodes: true,
	supportsWorkingDir: false,
}));
vi.mock('../../../main/agents', () => ({
	getAgentDefinition: (...args: unknown[]) => mockGetAgentDefinition(...args),
	getAgentCapabilities: (...args: unknown[]) => mockGetAgentCapabilities(...args),
}));

// Mock buildAgentArgs and applyAgentConfigOverrides
const mockBuildAgentArgs = vi.fn((_agent: unknown, _opts: unknown) => [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
	'--',
	'prompt-content',
]);
const mockApplyOverrides = vi.fn((_agent: unknown, args: string[], _overrides: unknown) => ({
	args,
	effectiveCustomEnvVars: undefined,
	customArgsSource: 'none' as const,
	customEnvSource: 'none' as const,
	modelSource: 'default' as const,
}));
vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: (...args: unknown[]) => mockBuildAgentArgs(...args),
	applyAgentConfigOverrides: (...args: unknown[]) => mockApplyOverrides(...args),
}));

// Mock wrapSpawnWithSsh
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../main/utils/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
}));

// Mock child_process.spawn
class MockChildProcess extends EventEmitter {
	stdin = {
		write: vi.fn(),
		end: vi.fn(),
	};
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(signal?: string) {
		this.killed = true;
		return true;
	}

	constructor() {
		super();
		// Set encoding methods on stdout/stderr
		(this.stdout as any).setEncoding = vi.fn();
		(this.stderr as any).setEncoding = vi.fn();
	}
}

let mockChild: MockChildProcess;
const mockSpawn = vi.fn(() => {
	mockChild = new MockChildProcess();
	return mockChild as unknown as ChildProcess;
});

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		spawn: (...args: unknown[]) => mockSpawn(...args),
		default: {
			...actual,
			spawn: (...args: unknown[]) => mockSpawn(...args),
		},
	};
});

// Must import after mocks
import {
	executeCuePrompt,
	stopCueRun,
	getActiveProcesses,
	recordCueHistoryEntry,
	type CueExecutionConfig,
} from '../../../main/cue/cue-executor';

// --- Helpers ---

function createMockSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
		...overrides,
	};
}

function createMockSubscription(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'Watch config',
		event: 'file.changed',
		enabled: true,
		prompt: 'prompts/on-config-change.md',
		watch: '**/*.yaml',
		...overrides,
	};
}

function createMockEvent(overrides: Partial<CueEvent> = {}): CueEvent {
	return {
		id: 'event-1',
		type: 'file.changed',
		timestamp: '2026-03-01T00:00:00.000Z',
		triggerName: 'Watch config',
		payload: {
			path: '/projects/test/config.yaml',
			filename: 'config.yaml',
			directory: '/projects/test',
			extension: '.yaml',
		},
		...overrides,
	};
}

function createMockTemplateContext(): TemplateContext {
	return {
		session: {
			id: 'session-1',
			name: 'Test Session',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		},
	};
}

function createExecutionConfig(overrides: Partial<CueExecutionConfig> = {}): CueExecutionConfig {
	return {
		runId: 'run-1',
		session: createMockSession(),
		subscription: createMockSubscription(),
		event: createMockEvent(),
		promptPath: 'prompts/on-config-change.md',
		toolType: 'claude-code',
		projectRoot: '/projects/test',
		templateContext: createMockTemplateContext(),
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

const defaultAgentDef = {
	id: 'claude-code',
	name: 'Claude Code',
	binaryName: 'claude',
	command: 'claude',
	args: [
		'--print',
		'--verbose',
		'--output-format',
		'stream-json',
		'--dangerously-skip-permissions',
	],
};

// --- Tests ---

describe('cue-executor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		getActiveProcesses().clear();

		// Default mock implementations
		mockReadFileSync.mockReturnValue('Prompt content: check {{CUE_FILE_PATH}}');
		mockGetAgentDefinition.mockReturnValue(defaultAgentDef);
		mockSubstitute.mockImplementation((template: string) => `substituted: ${template}`);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('executeCuePrompt', () => {
		it('should resolve relative prompt paths against projectRoot', async () => {
			const config = createExecutionConfig({
				promptPath: 'prompts/check.md',
				projectRoot: '/projects/test',
			});

			const resultPromise = executeCuePrompt(config);
			// Let spawn happen
			await vi.advanceTimersByTimeAsync(0);

			expect(mockReadFileSync).toHaveBeenCalledWith('/projects/test/prompts/check.md', 'utf-8');

			// Close the process to resolve
			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should use absolute prompt paths directly', async () => {
			const config = createExecutionConfig({
				promptPath: '/absolute/path/prompt.md',
			});

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockReadFileSync).toHaveBeenCalledWith('/absolute/path/prompt.md', 'utf-8');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should return failed result when prompt file cannot be read', async () => {
			mockReadFileSync.mockImplementation(() => {
				throw new Error('ENOENT: no such file');
			});

			const config = createExecutionConfig();
			const result = await executeCuePrompt(config);

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Failed to read prompt file');
			expect(result.stderr).toContain('ENOENT');
			expect(result.exitCode).toBeNull();
		});

		it('should populate Cue event data in template context', async () => {
			const event = createMockEvent({
				type: 'file.changed',
				payload: {
					path: '/projects/test/src/app.ts',
					filename: 'app.ts',
					directory: '/projects/test/src',
					extension: '.ts',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// Verify template context was populated with cue data
			expect(templateContext.cue).toEqual({
				eventType: 'file.changed',
				eventTimestamp: event.timestamp,
				triggerName: 'Watch config',
				runId: 'run-1',
				filePath: '/projects/test/src/app.ts',
				fileName: 'app.ts',
				fileDir: '/projects/test/src',
				fileExt: '.ts',
				sourceSession: '',
				sourceOutput: '',
			});

			// Verify substituteTemplateVariables was called
			expect(mockSubstitute).toHaveBeenCalledWith(
				'Prompt content: check {{CUE_FILE_PATH}}',
				templateContext
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should return failed result for unknown agent type', async () => {
			mockGetAgentDefinition.mockReturnValue(undefined);

			const config = createExecutionConfig({ toolType: 'nonexistent' });
			const result = await executeCuePrompt(config);

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Unknown agent type: nonexistent');
		});

		it('should build agent args using the same pipeline as process:spawn', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// Verify buildAgentArgs was called with proper params
			expect(mockBuildAgentArgs).toHaveBeenCalledWith(
				expect.objectContaining({
					id: 'claude-code',
					binaryName: 'claude',
					command: 'claude',
				}),
				expect.objectContaining({
					baseArgs: defaultAgentDef.args,
					cwd: '/projects/test',
					yoloMode: true,
				})
			);

			// Verify applyAgentConfigOverrides was called
			expect(mockApplyOverrides).toHaveBeenCalled();

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should spawn the process with correct command and args', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockSpawn).toHaveBeenCalledWith(
				'claude',
				expect.any(Array),
				expect.objectContaining({
					cwd: '/projects/test',
					stdio: ['pipe', 'pipe', 'pipe'],
				})
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should capture stdout and stderr from the process', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// Emit some output
			mockChild.stdout.emit('data', 'Hello ');
			mockChild.stdout.emit('data', 'world');
			mockChild.stderr.emit('data', 'Warning: something');

			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('Hello world');
			expect(result.stderr).toBe('Warning: something');
		});

		it('should return completed status on exit code 0', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
			expect(result.runId).toBe('run-1');
			expect(result.sessionId).toBe('session-1');
			expect(result.sessionName).toBe('Test Session');
			expect(result.subscriptionName).toBe('Watch config');
		});

		it('should return failed status on non-zero exit code', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('close', 1);
			const result = await resultPromise;

			expect(result.status).toBe('failed');
			expect(result.exitCode).toBe(1);
		});

		it('should handle spawn errors gracefully', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.emit('error', new Error('spawn ENOENT'));
			const result = await resultPromise;

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('Spawn error: spawn ENOENT');
			expect(result.exitCode).toBeNull();
		});

		it('should track the process in activeProcesses while running', async () => {
			const config = createExecutionConfig({ runId: 'tracked-run' });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(getActiveProcesses().has('tracked-run')).toBe(true);

			mockChild.emit('close', 0);
			await resultPromise;

			expect(getActiveProcesses().has('tracked-run')).toBe(false);
		});

		it('should use custom path when provided', async () => {
			const config = createExecutionConfig({
				customPath: '/custom/claude',
			});

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockSpawn).toHaveBeenCalledWith(
				'/custom/claude',
				expect.any(Array),
				expect.any(Object)
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should close stdin for local execution', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// For local (non-SSH) execution, stdin should just be closed
			expect(mockChild.stdin.end).toHaveBeenCalled();

			mockChild.emit('close', 0);
			await resultPromise;
		});

		describe('timeout enforcement', () => {
			it('should send SIGTERM when timeout expires', async () => {
				const config = createExecutionConfig({ timeoutMs: 5000 });
				const killSpy = vi.spyOn(mockChild, 'kill');

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				// Wait: re-spy after child is created
				const childKill = vi.spyOn(mockChild, 'kill');

				// Advance past timeout
				await vi.advanceTimersByTimeAsync(5000);

				expect(childKill).toHaveBeenCalledWith('SIGTERM');

				// Process exits after SIGTERM
				mockChild.emit('close', null);
				const result = await resultPromise;

				expect(result.status).toBe('timeout');
			});

			it('should escalate to SIGKILL after SIGTERM + delay', async () => {
				const config = createExecutionConfig({ timeoutMs: 5000 });

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				// Advance past timeout
				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGTERM');

				// Reset to track SIGKILL — but killed is already true so SIGKILL won't fire
				// since child.killed is true. That's correct behavior.
				mockChild.killed = false;

				// Advance past SIGKILL delay
				await vi.advanceTimersByTimeAsync(5000);
				expect(childKill).toHaveBeenCalledWith('SIGKILL');

				mockChild.emit('close', null);
				await resultPromise;
			});

			it('should not timeout when timeoutMs is 0', async () => {
				const config = createExecutionConfig({ timeoutMs: 0 });

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const childKill = vi.spyOn(mockChild, 'kill');

				// Advance a lot of time
				await vi.advanceTimersByTimeAsync(60000);
				expect(childKill).not.toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});
		});

		describe('SSH remote execution', () => {
			it('should call wrapSpawnWithSsh when SSH is enabled', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['-o', 'BatchMode=yes', 'user@host', 'claude --print'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'remote-1', name: 'My Server', host: 'host.example.com' },
				});

				const config = createExecutionConfig({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: mockSshStore,
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockWrapSpawnWithSsh).toHaveBeenCalledWith(
					expect.objectContaining({
						command: 'claude',
						agentBinaryName: 'claude',
					}),
					{ enabled: true, remoteId: 'remote-1' },
					mockSshStore
				);

				expect(mockSpawn).toHaveBeenCalledWith(
					'ssh',
					expect.arrayContaining(['-o', 'BatchMode=yes']),
					expect.objectContaining({ cwd: '/Users/test' })
				);

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('should write prompt to stdin for SSH large prompt mode', async () => {
				const mockSshStore = { getSshRemotes: vi.fn(() => []) };

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: 'large prompt content', // SSH returns prompt for stdin delivery
					sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host' },
				});

				const config = createExecutionConfig({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: mockSshStore,
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockChild.stdin.write).toHaveBeenCalledWith('large prompt content');
				expect(mockChild.stdin.end).toHaveBeenCalled();

				mockChild.emit('close', 0);
				await resultPromise;
			});
		});

		it('should pass custom model and args through config overrides', async () => {
			const config = createExecutionConfig({
				customModel: 'claude-4-opus',
				customArgs: '--max-tokens 1000',
				customEnvVars: { API_KEY: 'test-key' },
			});

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(mockApplyOverrides).toHaveBeenCalledWith(
				expect.anything(),
				expect.any(Array),
				expect.objectContaining({
					sessionCustomModel: 'claude-4-opus',
					sessionCustomArgs: '--max-tokens 1000',
					sessionCustomEnvVars: { API_KEY: 'test-key' },
				})
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should include event duration in the result', async () => {
			const config = createExecutionConfig();

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// Advance some time
			await vi.advanceTimersByTimeAsync(1500);

			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.durationMs).toBeGreaterThanOrEqual(1500);
			expect(result.startedAt).toBeTruthy();
			expect(result.endedAt).toBeTruthy();
		});

		it('should populate agent.completed event context correctly', async () => {
			const event = createMockEvent({
				type: 'agent.completed',
				triggerName: 'On agent done',
				payload: {
					sourceSession: 'builder-session',
					sourceOutput: 'Build completed successfully',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.sourceSession).toBe('builder-session');
			expect(templateContext.cue?.sourceOutput).toBe('Build completed successfully');

			mockChild.emit('close', 0);
			await resultPromise;
		});
	});

	describe('stopCueRun', () => {
		it('should return false for unknown runId', () => {
			expect(stopCueRun('nonexistent')).toBe(false);
		});

		it('should send SIGTERM to a running process', async () => {
			const config = createExecutionConfig({ runId: 'stop-test-run' });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			const childKill = vi.spyOn(mockChild, 'kill');

			const stopped = stopCueRun('stop-test-run');
			expect(stopped).toBe(true);
			expect(childKill).toHaveBeenCalledWith('SIGTERM');

			mockChild.emit('close', null);
			await resultPromise;
		});
	});

	describe('recordCueHistoryEntry', () => {
		it('should construct a proper CUE history entry', () => {
			const result: CueRunResult = {
				runId: 'run-1',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'Watch config',
				event: createMockEvent(),
				status: 'completed',
				stdout: 'Task completed successfully',
				stderr: '',
				exitCode: 0,
				durationMs: 5000,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:05.000Z',
			};

			const session = createMockSession();
			const entry = recordCueHistoryEntry(result, session);

			expect(entry.type).toBe('CUE');
			expect(entry.id).toBe('test-uuid-1234');
			expect(entry.summary).toBe('[CUE] "Watch config" (file.changed)');
			expect(entry.fullResponse).toBe('Task completed successfully');
			expect(entry.projectPath).toBe('/projects/test');
			expect(entry.sessionId).toBe('session-1');
			expect(entry.sessionName).toBe('Test Session');
			expect(entry.success).toBe(true);
			expect(entry.elapsedTimeMs).toBe(5000);
			expect(entry.cueTriggerName).toBe('Watch config');
			expect(entry.cueEventType).toBe('file.changed');
		});

		it('should set success to false for failed runs', () => {
			const result: CueRunResult = {
				runId: 'run-2',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'Periodic check',
				event: createMockEvent({ type: 'time.interval' }),
				status: 'failed',
				stdout: '',
				stderr: 'Error occurred',
				exitCode: 1,
				durationMs: 2000,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:02.000Z',
			};

			const entry = recordCueHistoryEntry(result, createMockSession());

			expect(entry.success).toBe(false);
			expect(entry.summary).toBe('[CUE] "Periodic check" (time.interval)');
		});

		it('should truncate long stdout in fullResponse', () => {
			const longOutput = 'x'.repeat(15000);
			const result: CueRunResult = {
				runId: 'run-3',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'Large output',
				event: createMockEvent(),
				status: 'completed',
				stdout: longOutput,
				stderr: '',
				exitCode: 0,
				durationMs: 1000,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:01.000Z',
			};

			const entry = recordCueHistoryEntry(result, createMockSession());

			expect(entry.fullResponse?.length).toBe(10000);
		});

		it('should set fullResponse to undefined when stdout is empty', () => {
			const result: CueRunResult = {
				runId: 'run-4',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'Silent run',
				event: createMockEvent(),
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 500,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:00.500Z',
			};

			const entry = recordCueHistoryEntry(result, createMockSession());

			expect(entry.fullResponse).toBeUndefined();
		});

		it('should populate cueSourceSession from agent.completed event payload', () => {
			const result: CueRunResult = {
				runId: 'run-5',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'On build done',
				event: createMockEvent({
					type: 'agent.completed',
					payload: {
						sourceSession: 'builder-agent',
					},
				}),
				status: 'completed',
				stdout: 'Done',
				stderr: '',
				exitCode: 0,
				durationMs: 3000,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:03.000Z',
			};

			const entry = recordCueHistoryEntry(result, createMockSession());

			expect(entry.cueSourceSession).toBe('builder-agent');
			expect(entry.cueEventType).toBe('agent.completed');
		});

		it('should set cueSourceSession to undefined when not present in payload', () => {
			const result: CueRunResult = {
				runId: 'run-6',
				sessionId: 'session-1',
				sessionName: 'Test Session',
				subscriptionName: 'Timer check',
				event: createMockEvent({
					type: 'time.interval',
					payload: { interval_minutes: 5 },
				}),
				status: 'completed',
				stdout: 'OK',
				stderr: '',
				exitCode: 0,
				durationMs: 1000,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:01.000Z',
			};

			const entry = recordCueHistoryEntry(result, createMockSession());

			expect(entry.cueSourceSession).toBeUndefined();
		});

		it('should use projectRoot for projectPath, falling back to cwd', () => {
			const session = createMockSession({ projectRoot: '', cwd: '/fallback/cwd' });
			const result: CueRunResult = {
				runId: 'run-7',
				sessionId: 'session-1',
				sessionName: 'Test',
				subscriptionName: 'Test',
				event: createMockEvent(),
				status: 'completed',
				stdout: '',
				stderr: '',
				exitCode: 0,
				durationMs: 100,
				startedAt: '2026-03-01T00:00:00.000Z',
				endedAt: '2026-03-01T00:00:00.100Z',
			};

			const entry = recordCueHistoryEntry(result, session);

			// Empty string is falsy, so should fall back to cwd
			expect(entry.projectPath).toBe('/fallback/cwd');
		});
	});
});
