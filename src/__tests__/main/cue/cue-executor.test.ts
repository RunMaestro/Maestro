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
 * - stdout clean extraction via the agent output parser
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
import { signalRemoteAgent } from '../../../shared/maestro-lib/control/ssh-remote-signal';
import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';
import { GrokOutputParser } from '../../../main/parsers/grok-output-parser';
import * as proofIdentity from '../../../main/plugins/plugin-tool-run-identity';
import * as wakaTime from '../../../main/wakatime-instance';
import { logger } from '../../../main/utils/logger';
import type { SpawnBuildResult } from '../../../main/cue/cue-spawn-builder';
import type { ChildProcess } from 'child_process';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

/**
 * An SSH store holding the remotes these tests point at. The launch plan
 * resolves the remote before wrapping, so an empty list is now an error.
 */
function sshStoreWithRemotes() {
	const remote = (id: string) => ({
		id,
		name: `Remote ${id}`,
		host: `${id}.example.com`,
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
	});
	return { getSshRemotes: vi.fn(() => [remote('remote-1'), remote('r1')]) };
}

// --- Mocks ---

// Mock fs - only `readFileSync` is overridden (the executor uses it for prompt
// files). Other methods (e.g. `existsSync`) pass through to the real module
// via `importOriginal`, because pulling in `cue-template-context-builder`
// transitively imports `cue-github-poller`, which calls `getExpandedEnv()` at
// module-load time and needs `fs.existsSync` for nvm/path detection.
const mockReadFileSync = vi.fn();
const { injectInvalidProof, buildBoundary } = vi.hoisted(() => ({
	injectInvalidProof: { current: false },
	buildBoundary: { afterBuild: undefined as ((result: SpawnBuildResult) => void) | undefined },
}));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
	};
});

vi.mock('../../../main/cue/cue-spawn-builder', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../main/cue/cue-spawn-builder')>();
	return {
		...actual,
		buildSpawnSpec: async (...args: Parameters<typeof actual.buildSpawnSpec>) => {
			const result = await actual.buildSpawnSpec(...args);
			if (injectInvalidProof.current && result.ok) {
				// Cleanup rejects this path after the provider has already completed.
				result.spec.pluginRunProofFile = '/invalid/not-a-proof';
			}
			buildBoundary.afterBuild?.(result);
			return result;
		},
	};
});

// Mock crypto. The real primitives stay: a plugin run proof mints its token
// with `randomBytes`, and a stub without it denies every proof. The UUID is a
// well-formed one: a remote prompt artifact's pid file name embeds it and is checked.
vi.mock('crypto', async (importOriginal) => ({
	...(await importOriginal<typeof import('crypto')>()),
	randomUUID: vi.fn(() => '00000000-0000-4000-8000-000000000001'),
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

// Mock buildAgentArgs and applyAgentConfigOverrides.
// buildAgentArgs returns flags only - it does NOT append the prompt as a positional arg.
// The executor is responsible for appending the prompt after applyAgentConfigOverrides.
// Keep Grok model/effort validation and its error class real for the launch planner.
const mockBuildAgentArgs = vi.fn((_agent: unknown, _opts: unknown) => [
	'--print',
	'--verbose',
	'--output-format',
	'stream-json',
	'--dangerously-skip-permissions',
]);
const mockApplyOverrides = vi.fn((_agent: unknown, args: string[], _overrides: unknown) => ({
	args,
	effectiveCustomEnvVars: undefined,
	customArgsSource: 'none' as const,
	customEnvSource: 'none' as const,
	modelSource: 'default' as const,
}));
vi.mock('../../../shared/maestro-lib/launch/agent-args', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../shared/maestro-lib/launch/agent-args')>()),
	buildAgentArgs: (...args: unknown[]) => mockBuildAgentArgs(...args),
	applyAgentConfigOverrides: (...args: unknown[]) => mockApplyOverrides(...args),
}));

// Mock wrapSpawnWithSsh
const mockWrapSpawnWithSsh = vi.fn();
vi.mock('../../../shared/maestro-lib/launch/ssh-spawn-wrapper', () => ({
	wrapSpawnWithSsh: (...args: unknown[]) => mockWrapSpawnWithSsh(...args),
	// Stand-in; the real wording is covered by the ssh-spawn-wrapper suite.
	sshUnresolvedRemoteMessage: (cfg: { remoteId: string | null }) =>
		`remote "${cfg.remoteId}" could not be resolved`,
}));
vi.mock('../../../shared/maestro-lib/control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../shared/maestro-lib/control/ssh-remote-signal')
	>()),
	signalRemoteAgent: vi.fn(),
}));

// Mock parsers - default returns null (no parser), overridden per test as needed
const mockGetOutputParser = vi.fn(
	() => null as ReturnType<typeof import('../../../main/parsers').getOutputParser>
);
// A resolved remote is probed for maestro-p before the token mode is chosen.
vi.mock('../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn(async () => true),
}));

vi.mock('../../../main/parsers', () => ({
	getOutputParser: (...args: unknown[]) => mockGetOutputParser(...args),
	createOutputParser: (...args: unknown[]) => mockGetOutputParser(...args),
}));

// Force the POSIX kill path (child.kill('SIGTERM')) in the underlying
// cue-process-lifecycle so these SIGTERM → SIGKILL assertions hold regardless of
// host OS. On Windows the product correctly uses taskkill /t /f instead, which
// these tests don't assert. This mirrors what CI exercises on Unix.
vi.mock('../../../shared/platformDetection', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../shared/platformDetection')>();
	return {
		...actual,
		isWindows: () => false,
	};
});

// Mock child_process.spawn
class MockChildProcess extends EventEmitter {
	pid = 12345;
	stdin = {
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	};
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;
	exitCode: number | null = null;
	signalCode: string | null = null;

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
	getCueProcessList,
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
		// Inline prompt content - as of the Phase 2 cleanup, the executor no longer
		// reads prompt files. The cue-config-normalizer resolves prompt_file at config
		// load time and stores the resolved content here.
		promptPath: 'Default test prompt body',
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
		injectInvalidProof.current = false;
		buildBoundary.afterBuild = undefined;
		vi.useFakeTimers();
		getActiveProcesses().clear();

		// Default mock implementations.
		// mockReadFileSync remains wired up so we can assert the executor never
		// touches the filesystem for prompt resolution (that's the normalizer's job).
		mockReadFileSync.mockReturnValue('SHOULD-NEVER-BE-READ');
		mockGetAgentDefinition.mockReturnValue(defaultAgentDef);
		mockSubstitute.mockImplementation((template: string) => `substituted: ${template}`);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('executeCuePrompt', () => {
		it('preserves a completed run when proof cleanup fails', async () => {
			injectInvalidProof.current = true;
			const onRunTranscript = vi.fn();
			const resultPromise = executeCuePrompt(createExecutionConfig({ onRunTranscript }));
			await vi.advanceTimersByTimeAsync(0);
			mockChild.stdout.emit('data', 'Completed output');
			mockChild.emit('close', 0);
			const result = await resultPromise;
			expect(result.status).toBe('completed');
			expect(result.exitCode).toBe(0);
			expect(onRunTranscript).toHaveBeenCalledTimes(1);
			expect(onRunTranscript).toHaveBeenCalledWith(
				expect.objectContaining({ rawStdout: 'Completed output', status: 'completed', exitCode: 0 })
			);
		});

		// As of the Phase 2 cleanup, the executor no longer resolves prompt files -
		// the cue-config-normalizer reads prompt_file at config-load time and stores
		// the resolved content in `prompt`. The executor's `promptPath` parameter is
		// now always inline prompt content.
		it('uses promptPath as inline prompt content (no filesystem read)', async () => {
			const config = createExecutionConfig({
				promptPath: 'Inline prompt body that came from the normalizer',
				projectRoot: '/projects/test',
			});

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// The executor must NOT touch the filesystem for prompt resolution.
			expect(mockReadFileSync).not.toHaveBeenCalled();

			// The prompt content should flow through unchanged to the template substitution.
			expect(mockSubstitute).toHaveBeenCalledWith(
				'Inline prompt body that came from the normalizer',
				expect.anything()
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		describe('New Session Message', () => {
			// Every Cue run is a fresh provider session (no --resume), so the
			// agent's standing instructions ride along on each one.
			it('prefixes the agent message onto the prompt of every run', async () => {
				const config = createExecutionConfig({
					promptPath: 'Triage the new issue',
					session: createMockSession({ newSessionMessage: 'Always answer in English' }),
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				expect(spawnedArgs[spawnedArgs.length - 1]).toBe(
					'Always answer in English\n\n---\n\nsubstituted: Triage the new issue'
				);

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('sends the prompt unchanged when the agent has no message', async () => {
				const config = createExecutionConfig({ promptPath: 'Triage the new issue' });

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				expect(spawnedArgs[spawnedArgs.length - 1]).toBe('substituted: Triage the new issue');

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it("is not template-substituted (it is the user's own text, not a Cue prompt)", async () => {
				const config = createExecutionConfig({
					promptPath: 'Triage the new issue',
					session: createMockSession({ newSessionMessage: 'Keep {{CUE_SOURCE_OUTPUT}} literal' }),
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				expect(mockSubstitute).not.toHaveBeenCalledWith(
					expect.stringContaining('Keep {{CUE_SOURCE_OUTPUT}} literal'),
					expect.anything()
				);

				mockChild.emit('close', 0);
				await resultPromise;
			});
		});

		it('returns failed result when prompt content is empty', async () => {
			const config = createExecutionConfig({ promptPath: '' });
			const result = await executeCuePrompt(config);

			expect(result.status).toBe('failed');
			expect(result.stderr).toContain('no prompt content');
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
			const config = createExecutionConfig({
				event,
				templateContext,
				// Inline prompt content (the normalizer would have resolved any prompt_file by now)
				promptPath: 'Prompt content: check {{CUE_FILE_PATH}}',
			});

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
				fileChangeType: '',
				sourceSession: '',
				sourceOutput: '',
				sourceStatus: '',
				sourceExitCode: '',
				sourceDuration: '',
				sourceTriggeredBy: '',
				fromAgent: '',
			});

			// Verify substituteTemplateVariables was called with the inline prompt content
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
					// Local mode uses 'ignore' for stdin so agents like Codex don't
					// emit "Reading additional input from stdin..." into the run
					// output before observing EOF.
					stdio: ['ignore', 'pipe', 'pipe'],
				})
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		describe('Maestro system prompt', () => {
			it('delivers appendSystemPrompt with the native flag for supporting agents', async () => {
				mockGetAgentCapabilities.mockReturnValueOnce({
					...mockGetAgentCapabilities(),
					supportsAppendSystemPrompt: true,
				} as any);
				const config = createExecutionConfig({
					promptPath: 'Hello world',
					appendSystemPrompt: 'MAESTRO SYS',
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				const idx = spawnedArgs.indexOf('--append-system-prompt');
				expect(idx).toBeGreaterThan(-1);
				expect(spawnedArgs[idx + 1]).toBe('MAESTRO SYS');
				expect(spawnedArgs[spawnedArgs.length - 1]).toContain('Hello world');

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('embeds appendSystemPrompt into the prompt for agents without the flag', async () => {
				const config = createExecutionConfig({
					promptPath: 'Hello world',
					appendSystemPrompt: 'MAESTRO SYS',
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				expect(spawnedArgs).not.toContain('--append-system-prompt');
				const last = spawnedArgs[spawnedArgs.length - 1];
				expect(last).toContain('MAESTRO SYS');
				expect(last).toContain('Hello world');

				mockChild.emit('close', 0);
				await resultPromise;
			});
		});

		describe('prompt appended as CLI positional arg', () => {
			it('appends -- then prompt for agents with no promptArgs/noPromptSeparator (default)', async () => {
				// defaultAgentDef has neither promptArgs nor noPromptSeparator
				const config = createExecutionConfig({ promptPath: 'Hello world' });

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				// Last two args should be '--' and the substituted prompt
				expect(spawnedArgs[spawnedArgs.length - 2]).toBe('--');
				expect(spawnedArgs[spawnedArgs.length - 1]).toContain('Hello world');

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('uses promptArgs when the agent definition provides it', async () => {
				mockGetAgentDefinition.mockReturnValue({
					...defaultAgentDef,
					promptArgs: (p: string) => ['-p', p],
				});
				const config = createExecutionConfig({ promptPath: 'Hello world' });

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				const pIdx = spawnedArgs.indexOf('-p');
				expect(pIdx).toBeGreaterThan(-1);
				expect(spawnedArgs[pIdx + 1]).toContain('Hello world');

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('appends prompt directly when noPromptSeparator is true', async () => {
				mockGetAgentDefinition.mockReturnValue({
					...defaultAgentDef,
					noPromptSeparator: true,
				});
				const config = createExecutionConfig({ promptPath: 'Hello world' });

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				// Last arg is prompt, no '--' separator
				expect(spawnedArgs[spawnedArgs.length - 1]).toContain('Hello world');
				expect(spawnedArgs[spawnedArgs.length - 2]).not.toBe('--');

				mockChild.emit('close', 0);
				await resultPromise;
			});

			it('does not double-append prompt for SSH execution (wrapper handles it)', async () => {
				const mockSshStore = sshStoreWithRemotes();

				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'ssh',
					args: ['user@host', 'claude', '--print', '--', 'Hello world'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'remote-1', name: 'Server', host: 'host' },
				});

				const config = createExecutionConfig({
					promptPath: 'Hello world',
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: mockSshStore,
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);

				const [, spawnedArgs] = mockSpawn.mock.calls[0] as [string, string[], unknown];
				// spawnArgs come from sshResult.args - the prompt appears exactly once
				const promptOccurrences = spawnedArgs.filter((a) => a.includes('Hello world')).length;
				expect(promptOccurrences).toBe(1);

				mockChild.emit('close', 0);
				await resultPromise;
			});
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

		// `onRunTranscript` is how the chain of thought export reads a Cue run. It
		// is an observer: it sees the finished run and cannot change it.
		describe('onRunTranscript', () => {
			it('hands over the raw transcript once, after the run', async () => {
				const onRunTranscript = vi.fn();
				const config = createExecutionConfig({
					promptPath: 'Summarize the change',
					onRunTranscript,
				});

				const resultPromise = executeCuePrompt(config);
				await vi.advanceTimersByTimeAsync(0);
				mockChild.stdout.emit('data', 'Hello ');
				mockChild.stdout.emit('data', 'world');
				expect(onRunTranscript).not.toHaveBeenCalled();
				mockChild.emit('close', 0);
				const result = await resultPromise;

				expect(onRunTranscript).toHaveBeenCalledTimes(1);
				const run = onRunTranscript.mock.calls[0][0];
				expect(run).toMatchObject({
					agentId: 'session-1',
					toolType: 'claude-code',
					prompt: 'substituted: Summarize the change',
					rawStdout: 'Hello world',
					cwd: '/projects/test',
					exitCode: 0,
					status: 'completed',
					durationMs: result.durationMs,
				});
				expect(run.startTime).toBe(Date.parse(result.startedAt));
			});

			it('reports a failed run with its exit code', async () => {
				const onRunTranscript = vi.fn();
				const resultPromise = executeCuePrompt(createExecutionConfig({ onRunTranscript }));
				await vi.advanceTimersByTimeAsync(0);

				mockChild.emit('close', 1);
				await resultPromise;

				expect(onRunTranscript.mock.calls[0][0]).toMatchObject({ exitCode: 1, status: 'failed' });
			});

			it('does not change the result, and a throwing callback does not fail the run', async () => {
				const runOnce = async (overrides: Partial<CueExecutionConfig>) => {
					const resultPromise = executeCuePrompt(createExecutionConfig(overrides));
					await vi.advanceTimersByTimeAsync(0);
					mockChild.stdout.emit('data', 'Hello world');
					mockChild.stderr.emit('data', 'Warning');
					mockChild.emit('close', 0);
					return resultPromise;
				};

				const plain = await runOnce({});
				const observed = await runOnce({
					onRunTranscript: () => {
						throw new Error('observer failed');
					},
				});

				const comparable = (r: typeof plain) => ({
					status: r.status,
					stdout: r.stdout,
					stderr: r.stderr,
					exitCode: r.exitCode,
					durationMs: r.durationMs,
				});
				expect(comparable(observed)).toEqual(comparable(plain));
				expect(observed.status).toBe('completed');
			});

			it('is not called when no process was started', async () => {
				const onRunTranscript = vi.fn();

				const result = await executeCuePrompt(
					createExecutionConfig({ promptPath: '   ', onRunTranscript })
				);

				expect(result.status).toBe('failed');
				expect(onRunTranscript).not.toHaveBeenCalled();
			});
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

				// Reset to track SIGKILL - but killed is already true so SIGKILL won't fire
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

		describe('a run stopped before its process starts', () => {
			it('spawns nothing when stopped while the SSH resolution is awaited', async () => {
				let resolveWrap!: (value: unknown) => void;
				mockWrapSpawnWithSsh.mockImplementationOnce(
					() =>
						new Promise((resolve) => {
							resolveWrap = resolve;
						})
				);
				const controller = new AbortController();
				const resultPromise = executeCuePrompt(
					createExecutionConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
						sshStore: sshStoreWithRemotes(),
						signal: controller.signal,
					})
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);

				controller.abort();
				resolveWrap({
					command: 'ssh',
					args: ['user@host'],
					cwd: '/Users/test',
					customEnvVars: undefined,
					prompt: undefined,
					sshRemoteUsed: { id: 'remote-1', name: 'My Server', host: 'host.example.com' },
				});
				const result = await resultPromise;

				expect(mockSpawn).not.toHaveBeenCalled();
				expect(getActiveProcesses().size).toBe(0);
				expect(result).toMatchObject({ status: 'stopped', stdout: '', stderr: '', exitCode: null });
			});

			it('spawns nothing when the signal is already aborted', async () => {
				const controller = new AbortController();
				controller.abort();
				const result = await executeCuePrompt(createExecutionConfig({ signal: controller.signal }));
				expect(mockSpawn).not.toHaveBeenCalled();
				expect(result.status).toBe('stopped');
			});
		});

		describe('SSH remote execution', () => {
			it('should call wrapSpawnWithSsh when SSH is enabled', async () => {
				const mockSshStore = sshStoreWithRemotes();

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

			it('fails the run without spawning when the wrapper cannot resolve the planned remote', async () => {
				// The launch plan resolved the remote; the wrapper then handed back the
				// local config (remote deleted or disabled in between).
				mockWrapSpawnWithSsh.mockResolvedValue({
					command: 'claude',
					args: ['--print'],
					cwd: '/projects/test',
					customEnvVars: undefined,
					prompt: 'test prompt',
					sshRemoteUsed: null,
				});
				const onLog = vi.fn();

				const result = await executeCuePrompt(
					createExecutionConfig({
						sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
						sshStore: sshStoreWithRemotes(),
						onLog,
					})
				);

				expect(mockSpawn).not.toHaveBeenCalled();
				expect(result.status).toBe('failed');
				expect(result.stderr).toBe('remote "remote-1" could not be resolved');
				expect(onLog).toHaveBeenCalledWith('error', 'remote "remote-1" could not be resolved');
			});

			it('should write prompt to stdin for SSH large prompt mode', async () => {
				const mockSshStore = sshStoreWithRemotes();

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

				expect(mockChild.stdin.write).toHaveBeenCalledWith(
					'large prompt content',
					expect.any(Function)
				);
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

		it('should populate github.pull_request event context correctly', async () => {
			const subscription = createMockSubscription({
				name: 'PR watcher',
				event: 'github.pull_request',
			});
			const event = createMockEvent({
				type: 'github.pull_request',
				triggerName: 'PR watcher',
				payload: {
					type: 'pull_request',
					number: 42,
					title: 'Add feature X',
					author: 'octocat',
					url: 'https://github.com/owner/repo/pull/42',
					body: 'This PR adds feature X',
					labels: 'enhancement,review-needed',
					state: 'open',
					repo: 'owner/repo',
					head_branch: 'feature-x',
					base_branch: 'main',
					assignees: '',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, subscription, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.ghType).toBe('pull_request');
			expect(templateContext.cue?.ghNumber).toBe('42');
			expect(templateContext.cue?.ghTitle).toBe('Add feature X');
			expect(templateContext.cue?.ghAuthor).toBe('octocat');
			expect(templateContext.cue?.ghUrl).toBe('https://github.com/owner/repo/pull/42');
			expect(templateContext.cue?.ghBranch).toBe('feature-x');
			expect(templateContext.cue?.ghBaseBranch).toBe('main');
			expect(templateContext.cue?.ghRepo).toBe('owner/repo');
			// Base cue fields should still be populated
			expect(templateContext.cue?.eventType).toBe('github.pull_request');
			expect(templateContext.cue?.triggerName).toBe('PR watcher');
			expect(templateContext.cue?.runId).toBe('run-1');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should populate github.issue event context correctly', async () => {
			const subscription = createMockSubscription({
				name: 'Issue watcher',
				event: 'github.issue',
			});
			const event = createMockEvent({
				type: 'github.issue',
				triggerName: 'Issue watcher',
				payload: {
					type: 'issue',
					number: 99,
					title: 'Bug report',
					author: 'user1',
					url: 'https://github.com/owner/repo/issues/99',
					body: 'Found a bug',
					labels: 'bug',
					state: 'open',
					repo: 'owner/repo',
					assignees: 'dev1,dev2',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, subscription, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.ghType).toBe('issue');
			expect(templateContext.cue?.ghNumber).toBe('99');
			expect(templateContext.cue?.ghAssignees).toBe('dev1,dev2');
			// head_branch / base_branch not in payload → empty string
			expect(templateContext.cue?.ghBranch).toBe('');
			expect(templateContext.cue?.ghBaseBranch).toBe('');
			// Base cue fields preserved
			expect(templateContext.cue?.eventType).toBe('github.issue');
			expect(templateContext.cue?.triggerName).toBe('Issue watcher');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should populate file.changed changeType in template context', async () => {
			const event = createMockEvent({
				type: 'file.changed',
				payload: {
					path: '/projects/test/new-file.ts',
					filename: 'new-file.ts',
					directory: '/projects/test',
					extension: '.ts',
					changeType: 'add',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.fileChangeType).toBe('add');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should populate agent.completed event context correctly', async () => {
			const event = createMockEvent({
				type: 'agent.completed',
				triggerName: 'On agent done',
				payload: {
					sourceSession: 'builder-session',
					sourceOutput: 'Build completed successfully',
					status: 'completed',
					exitCode: 0,
					durationMs: 15000,
					triggeredBy: 'lint-on-save',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.sourceSession).toBe('builder-session');
			expect(templateContext.cue?.sourceOutput).toBe('Build completed successfully');
			expect(templateContext.cue?.sourceStatus).toBe('completed');
			expect(templateContext.cue?.sourceExitCode).toBe('0');
			expect(templateContext.cue?.sourceDuration).toBe('15000');
			expect(templateContext.cue?.sourceTriggeredBy).toBe('lint-on-save');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should populate task.pending event context correctly', async () => {
			const event = createMockEvent({
				type: 'task.pending',
				triggerName: 'Task watcher',
				payload: {
					path: '/projects/test/TODO.md',
					filename: 'TODO.md',
					directory: '/projects/test',
					taskCount: 3,
					taskList: '- [ ] Fix login bug\n- [ ] Update docs\n- [ ] Add tests',
					content: '# TODO\n- [ ] Fix login bug\n- [ ] Update docs\n- [ ] Add tests',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.taskFile).toBe('/projects/test/TODO.md');
			expect(templateContext.cue?.taskFileName).toBe('TODO.md');
			expect(templateContext.cue?.taskFileDir).toBe('/projects/test');
			expect(templateContext.cue?.taskCount).toBe('3');
			expect(templateContext.cue?.taskList).toBe(
				'- [ ] Fix login bug\n- [ ] Update docs\n- [ ] Add tests'
			);
			expect(templateContext.cue?.taskContent).toBe(
				'# TODO\n- [ ] Fix login bug\n- [ ] Update docs\n- [ ] Add tests'
			);

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should preserve base cue context alongside task fields', async () => {
			const event = createMockEvent({
				type: 'task.pending',
				triggerName: 'Task watcher',
				payload: {
					path: '/projects/test/TODO.md',
					filename: 'TODO.md',
					directory: '/projects/test',
					taskCount: 1,
					taskList: '- [ ] Single task',
					content: '- [ ] Single task',
				},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// Base cue fields should still be populated
			expect(templateContext.cue?.eventType).toBe('task.pending');
			expect(templateContext.cue?.triggerName).toBe('Watch config'); // from subscription.name
			expect(templateContext.cue?.runId).toBeDefined();
			expect(templateContext.cue?.eventTimestamp).toBeDefined();

			// Task-specific fields coexist
			expect(templateContext.cue?.taskCount).toBe('1');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should default task fields to empty/zero when payload is missing', async () => {
			const event = createMockEvent({
				type: 'task.pending',
				triggerName: 'Task watcher',
				payload: {},
			});

			const templateContext = createMockTemplateContext();
			const config = createExecutionConfig({ event, templateContext });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			expect(templateContext.cue?.taskFile).toBe('');
			expect(templateContext.cue?.taskFileName).toBe('');
			expect(templateContext.cue?.taskFileDir).toBe('');
			expect(templateContext.cue?.taskCount).toBe('0');
			expect(templateContext.cue?.taskList).toBe('');
			expect(templateContext.cue?.taskContent).toBe('');

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

	describe('stdout clean extraction via output parser', () => {
		it('should return raw stdout when no parser is registered for the agent', async () => {
			mockGetOutputParser.mockReturnValue(null);

			const config = createExecutionConfig({ toolType: 'claude-code' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'plain text output\n');
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('plain text output\n');
		});

		it('should extract result-event text when parser is available', async () => {
			const ndjson = [
				JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
				JSON.stringify({
					type: 'text',
					part: { text: 'Hello! Fun fact: bees can recognize human faces.' },
				}),
				JSON.stringify({
					type: 'step_finish',
					part: { reason: 'stop', tokens: { input: 10, output: 20 } },
				}),
			].join('\n');

			mockGetOutputParser.mockReturnValue({
				extractSessionId: () => null,
				parseJsonLine: (line: string) => {
					try {
						const msg = JSON.parse(line);
						if (msg.type === 'text') {
							return { type: 'result', text: msg.part?.text || '' };
						}
						return { type: 'system', raw: msg };
					} catch {
						return { type: 'text', text: line };
					}
				},
			} as any);

			const config = createExecutionConfig({ toolType: 'opencode' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', ndjson);
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('Hello! Fun fact: bees can recognize human faces.');
		});

		it('should join multiple result-event text chunks with newlines', async () => {
			mockGetOutputParser.mockReturnValue({
				extractSessionId: () => null,
				parseJsonLine: (line: string) => {
					try {
						const msg = JSON.parse(line);
						if (msg.type === 'text') {
							return { type: 'result', text: msg.part?.text || '' };
						}
						return { type: 'system', raw: msg };
					} catch {
						return { type: 'text', text: line };
					}
				},
			} as any);

			const ndjson = [
				JSON.stringify({ type: 'text', part: { text: 'First paragraph.' } }),
				JSON.stringify({ type: 'text', part: { text: 'Second paragraph.' } }),
			].join('\n');

			const config = createExecutionConfig({ toolType: 'opencode' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', ndjson);
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('First paragraph.\nSecond paragraph.');
		});

		it('should fall back to raw stdout when parser finds no result events', async () => {
			// Parser that only returns system events (no result events)
			mockGetOutputParser.mockReturnValue({
				extractSessionId: () => null,
				parseJsonLine: (_line: string) => ({ type: 'system', raw: {} }),
			} as any);

			const rawOutput = '{"type":"step_start","part":{"type":"step-start"}}';

			const config = createExecutionConfig({ toolType: 'opencode' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', rawOutput);
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe(rawOutput);
		});

		it('should fall back to assistant text when result event has empty text', async () => {
			// Simulates Claude Code output where the result event has an empty
			// string but assistant messages contain the actual response text.
			const msgId = 'msg_test123';
			mockGetOutputParser.mockReturnValue({
				extractSessionId: () => null,
				parseJsonLine: (line: string) => {
					try {
						const msg = JSON.parse(line);
						if (msg.type === 'assistant' && msg.message?.content) {
							const textBlock = msg.message.content.find((b: any) => b.type === 'text');
							return {
								type: 'text',
								text: textBlock?.text || '',
								sessionId: msg.session_id,
								isPartial: true,
								raw: msg,
							};
						}
						if (msg.type === 'result') {
							return { type: 'result', text: msg.result || '', raw: msg };
						}
						return { type: 'system', raw: msg };
					} catch {
						return { type: 'system', raw: {} };
					}
				},
			} as any);

			const ndjson = [
				JSON.stringify({
					type: 'assistant',
					message: {
						id: msgId,
						role: 'assistant',
						content: [{ type: 'text', text: 'Here is the summary of your data.' }],
					},
					session_id: 'sess-1',
				}),
				JSON.stringify({
					type: 'assistant',
					message: {
						id: msgId,
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }],
					},
					session_id: 'sess-1',
				}),
				JSON.stringify({
					type: 'result',
					result: '',
					session_id: 'sess-1',
				}),
			].join('\n');

			const config = createExecutionConfig({ toolType: 'claude-code' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', ndjson);
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('Here is the summary of your data.');
		});

		it('should deduplicate streaming assistant chunks by message ID', async () => {
			// Claude Code streams assistant messages as chunks with increasing
			// content. The same message ID appears multiple times. We should
			// keep only the longest (latest) version per message ID.
			const msgId = 'msg_dedup';
			mockGetOutputParser.mockReturnValue({
				extractSessionId: () => null,
				parseJsonLine: (line: string) => {
					try {
						const msg = JSON.parse(line);
						if (msg.type === 'assistant' && msg.message?.content) {
							const textBlock = msg.message.content.find((b: any) => b.type === 'text');
							return {
								type: 'text',
								text: textBlock?.text || '',
								isPartial: true,
								raw: msg,
							};
						}
						if (msg.type === 'result') {
							return { type: 'result', text: msg.result || '', raw: msg };
						}
						return { type: 'system', raw: msg };
					} catch {
						return { type: 'system', raw: {} };
					}
				},
			} as any);

			const ndjson = [
				JSON.stringify({
					type: 'assistant',
					message: { id: msgId, content: [{ type: 'text', text: 'Hello' }] },
				}),
				JSON.stringify({
					type: 'assistant',
					message: {
						id: msgId,
						content: [{ type: 'text', text: 'Hello, here is a longer response.' }],
					},
				}),
				JSON.stringify({ type: 'result', result: '' }),
			].join('\n');

			const config = createExecutionConfig({ toolType: 'claude-code' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', ndjson);
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.stdout).toBe('Hello, here is a longer response.');
		});
	});

	describe('provider session id extraction', () => {
		it('returns the provider session id parsed from stdout (last id wins)', async () => {
			// Each run produces one provider session; the parser may surface the id
			// on several events. The last one (the authoritative `result` event,
			// emitted last) is what we keep for token attribution.
			mockGetOutputParser.mockReturnValue({
				parseJsonLine: (line: string) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				},
				extractSessionId: (event: any) => event?.session_id ?? null,
			} as any);

			const ndjson = [
				JSON.stringify({ type: 'system', session_id: 'sess-init' }),
				JSON.stringify({ type: 'assistant', message: {} }),
				JSON.stringify({ type: 'result', session_id: 'sess-final' }),
			].join('\n');

			const config = createExecutionConfig({ toolType: 'claude-code' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', ndjson);
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.providerSessionId).toBe('sess-final');
		});

		it('returns null provider session id when no parser is registered', async () => {
			// Plain-text agents / command runs have no parser to mine an id from.
			mockGetOutputParser.mockReturnValue(null);

			const config = createExecutionConfig({ toolType: 'claude-code' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', 'plain text output\n');
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.providerSessionId).toBeNull();
		});

		it('returns null provider session id when stdout carries no session id', async () => {
			mockGetOutputParser.mockReturnValue({
				parseJsonLine: (line: string) => {
					try {
						return JSON.parse(line);
					} catch {
						return null;
					}
				},
				extractSessionId: () => null,
			} as any);

			const config = createExecutionConfig({ toolType: 'claude-code' });
			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			mockChild.stdout.emit('data', JSON.stringify({ type: 'result', text: 'done' }));
			mockChild.emit('close', 0);
			const result = await resultPromise;

			expect(result.providerSessionId).toBeNull();
		});
	});

	describe('getCueProcessList', () => {
		it('should return empty array when no active processes', () => {
			expect(getCueProcessList()).toEqual([]);
		});

		it('should return process info during active run', async () => {
			const config = createExecutionConfig({ runId: 'list-test-run', toolType: 'claude-code' });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			const list = getCueProcessList();
			expect(list).toHaveLength(1);
			expect(list[0].runId).toBe('list-test-run');
			expect(list[0].pid).toBe(12345);
			expect(list[0].toolType).toBe('claude-code');
			expect(list[0].cwd).toBe('/projects/test');
			expect(list[0].command).toBe('claude');
			expect(Array.isArray(list[0].args)).toBe(true);
			expect(typeof list[0].startTime).toBe('number');

			mockChild.emit('close', 0);
			await resultPromise;
		});

		it('should exclude completed processes', async () => {
			const config = createExecutionConfig({ runId: 'completed-run' });

			const resultPromise = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);

			// Process is active - should appear in list
			const activeEntry = getActiveProcesses().get('completed-run');
			expect(activeEntry).toBeDefined();
			expect(getCueProcessList().some((p) => p.runId === 'completed-run')).toBe(true);

			mockChild.emit('close', 0);
			await resultPromise;

			// Process completed - should be removed
			expect(getActiveProcesses().has('completed-run')).toBe(false);
			expect(getCueProcessList().some((p) => p.runId === 'completed-run')).toBe(false);
		});
	});

	describe('plugin proof ownership after build resolution', () => {
		const proofFile = path.resolve('maestro-plugin-run-private-fixture', 'proof');
		const privateContent = 'SYNTHETIC_PRIVATE_CUE_PROMPT';
		let token: string | undefined;
		const ownedFiles = new Set<string>();
		let removeProof: ReturnType<typeof vi.spyOn>;
		let revoke: ReturnType<typeof vi.spyOn>;
		let warn: ReturnType<typeof vi.spyOn>;

		beforeEach(() => {
			token = undefined;
			ownedFiles.clear();
			mockGetOutputParser.mockReturnValue(null);
			removeProof = vi
				.spyOn(proofIdentity, 'removePluginRunProofFile')
				.mockImplementation((file) => {
					expect(ownedFiles.delete(file)).toBe(true);
				});
			revoke = vi.spyOn(proofIdentity.pluginToolRunIdentity, 'revoke');
			warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
			buildBoundary.afterBuild = (result) => {
				if (!result.ok) return;
				token = proofIdentity.pluginToolRunIdentity.issue('session-1');
				ownedFiles.add(proofFile);
				result.spec.pluginRunToken = token;
				result.spec.pluginRunProofFile = proofFile;
			};
		});

		afterEach(() => {
			vi.restoreAllMocks();
			if (token) proofIdentity.pluginToolRunIdentity.revoke(token);
			buildBoundary.afterBuild = undefined;
		});

		function expectProofReleased() {
			expect(token).toBeDefined();
			expect(revoke).toHaveBeenCalledExactlyOnceWith(token);
			expect(proofIdentity.pluginToolRunIdentity.resolve(token).callerAgentId).toBeNull();
			expect(removeProof).toHaveBeenCalledExactlyOnceWith(proofFile);
			expect(ownedFiles.size).toBe(0);
		}

		describe('canonical prompt artifact handoff', () => {
			isolateAgentEnv();
			beforeEach(() => {
				mockGetAgentDefinition.mockReturnValue({
					...defaultAgentDef,
					id: 'grok',
					command: 'grok',
					binaryName: 'grok',
					promptFile: { format: 'acp-json', exclusivePromptFlags: ['-p', '--prompt-file'] },
					promptFileArgs: (file: string) => ['--prompt-file', file],
				});
				vi.spyOn(fs, 'openSync').mockReturnValue(91);
				vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
				vi.spyOn(fs, 'fstatSync').mockReturnValue({ dev: 1, ino: 2 } as fs.Stats);
				vi.spyOn(fs, 'lstatSync').mockReturnValue({ dev: 1, ino: 2 } as fs.Stats);
				vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
				vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
			});

			// A Grok turn finishes only on its native success record, so
			// the clean row writes one; the failed row stays silent.
			it.each([0, 7])('retains local bytes and identity through exit %i', async (exitCode) => {
				if (exitCode === 0) mockGetOutputParser.mockReturnValue(new GrokOutputParser());
				const [result, runningProcesses] = await Promise.all([
					executeCuePrompt(
						createExecutionConfig({
							toolType: 'grok',
							promptPath: privateContent,
							appendSystemPrompt: 'SYSTEM',
							customPath: '/fixture/grok',
							customEnvVars: { GROK_HOME: '/fixture/account' },
							session: createMockSession({ newSessionMessage: 'FIRST' }),
						})
					),
					(async () => {
						await vi.advanceTimersByTimeAsync(0);
						expect(mockSpawn).toHaveBeenCalledTimes(1);
						expect(fs.unlinkSync).not.toHaveBeenCalled();
						const runningProcesses = getCueProcessList();
						expect(runningProcesses).toHaveLength(1);
						if (exitCode === 0)
							mockChild.stdout.emit(
								'data',
								JSON.stringify({ type: 'end', stopReason: 'end_turn', sessionId: 'grok-s1' }) + '\n'
							);
						mockChild.emit('close', exitCode);
						return JSON.stringify(runningProcesses);
					})(),
				]);
				expect(result).toMatchObject({
					exitCode,
					status: exitCode ? 'failed' : 'completed',
				});
				const file = vi.mocked(fs.openSync).mock.calls[0][0];
				expect(fs.openSync).toHaveBeenCalledExactlyOnceWith(file, 'wx', 0o600);
				expect(fs.writeFileSync).toHaveBeenCalledExactlyOnceWith(
					91,
					JSON.stringify({
						type: 'acp',
						content: [
							{
								type: 'text',
								text: embedSystemPromptInPrompt(
									'SYSTEM',
									`FIRST\n\n---\n\nsubstituted: ${privateContent}`
								),
							},
						],
					}),
					'utf8'
				);
				expect(mockSpawn).toHaveBeenCalledExactlyOnceWith(
					'/fixture/grok',
					expect.arrayContaining(['--prompt-file', file]),
					expect.objectContaining({
						env: expect.objectContaining({ GROK_HOME: '/fixture/account' }),
						stdio: ['ignore', 'pipe', 'pipe'],
					})
				);
				expect(mockChild.stdin.write).not.toHaveBeenCalled();
				expect(runningProcesses).not.toContain(String(file));
				expect(fs.unlinkSync).toHaveBeenCalledExactlyOnceWith(file);
				expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(91);
				expectProofReleased();
			});

			it('fails a silent clean Grok exit with no native terminal record', async () => {
				const resultPromise = executeCuePrompt(
					createExecutionConfig({ toolType: 'grok', promptPath: privateContent })
				);
				await vi.advanceTimersByTimeAsync(0);
				expect(mockSpawn).toHaveBeenCalledTimes(1);
				mockChild.emit('close', 0);
				const result = await resultPromise;
				expect(result).toMatchObject({ exitCode: 0, status: 'failed' });
				expect(result.stderr).toContain('native terminal record');
				expectProofReleased();
			});

			it.each(['partial write', 'competing stdin', 'transport mismatch'])(
				'refuses %s and never retries text',
				async (failure) => {
					if (failure === 'partial write')
						vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
							throw new Error(`/private/artifact: ${privateContent}`);
						});
					else {
						const attachProof = buildBoundary.afterBuild!;
						buildBoundary.afterBuild = (result) => {
							attachProof(result);
							if (!result.ok) return;
							if (failure === 'competing stdin') result.spec.stdinPrompt = privateContent;
							else result.spec.promptArtifact!.owner = 'remote';
						};
					}
					const config = createExecutionConfig({ toolType: 'grok', promptPath: privateContent });
					const result = await executeCuePrompt(config);
					expect(result).toMatchObject({
						status: 'failed',
						stderr:
							failure === 'partial write'
								? 'Spawn error: Prompt-file launch failed.'
								: 'Prompt-file preparation unavailable.',
					});
					expect(mockSpawn).not.toHaveBeenCalled();
					expect(mockBuildAgentArgs).toHaveBeenCalledTimes(1);
					expect(fs.openSync).toHaveBeenCalledTimes(failure === 'partial write' ? 1 : 0);
					expect(fs.unlinkSync).toHaveBeenCalledTimes(failure === 'partial write' ? 1 : 0);
					if (failure === 'partial write') expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(91);
					expect(JSON.stringify([result, vi.mocked(config.onLog).mock.calls])).not.toContain(
						privateContent
					);
					expectProofReleased();
				}
			);

			it.each(['cancel', 'timeout', 'transport failure'])(
				'keeps SSH ownership on %s without local writes',
				async (ending) => {
					mockWrapSpawnWithSsh.mockImplementationOnce(async () => ({
						command: 'ssh',
						args: ['dev@r1.example.com', '/bin/bash', '--norc', '--noprofile', '-s'],
						cwd: '/fixture-client',
						sshStdinScript: 'fixture private launch',
						sshRemoteUsed: { id: 'r1', name: 'Remote', host: 'r1.example.com' },
					}));
					const controller = new AbortController();
					const [result] = await Promise.all([
						executeCuePrompt(
							createExecutionConfig({
								toolType: 'grok',
								signal: controller.signal,
								timeoutMs: 100,
								sshRemoteConfig: { enabled: true, remoteId: 'r1' },
								sshStore: sshStoreWithRemotes(),
							})
						),
						(async () => {
							await vi.advanceTimersByTimeAsync(0);
							expect(mockSpawn).toHaveBeenCalledTimes(1);
							if (ending === 'cancel') controller.abort();
							if (ending === 'timeout') await vi.advanceTimersByTimeAsync(100);
							mockChild.emit('close', ending === 'transport failure' ? 255 : null);
						})(),
					]);
					expect(result.status).toBe(
						ending === 'cancel' ? 'stopped' : ending === 'timeout' ? 'timeout' : 'failed'
					);
					expect(mockWrapSpawnWithSsh).toHaveBeenCalledTimes(1);
					const artifact = mockWrapSpawnWithSsh.mock.lastCall![0].promptArtifact;
					expect(mockChild.stdin.write).toHaveBeenCalledOnce();
					const script = mockChild.stdin.write.mock.calls[0][0] as string;
					expect(script).toContain(artifact.path);
					expect(script.match(/readonly _maestro_prompt_pid_file=/g)).toHaveLength(1);
					expect(signalRemoteAgent).toHaveBeenCalledWith(
						expect.objectContaining({
							promptArtifactPath: artifact.path,
							sessionId: 'run-1',
							sshArgs: mockSpawn.mock.calls[0][1],
						}),
						'terminate'
					);
					expect(fs.openSync).not.toHaveBeenCalled();
					expect(fs.unlinkSync).not.toHaveBeenCalled();
					expect(mockSpawn).toHaveBeenCalledTimes(1);
					expectProofReleased();
				}
			);
		});

		it('releases a successful build cancelled in the microtask before executor continuation', async () => {
			const controller = new AbortController();
			const attachProof = buildBoundary.afterBuild!;
			buildBoundary.afterBuild = (result) => {
				expect(result.ok).toBe(true);
				attachProof(result);
				void Promise.resolve().then(() => controller.abort());
			};
			const onRunTranscript = vi.fn();
			const result = await executeCuePrompt(
				createExecutionConfig({ signal: controller.signal, onRunTranscript })
			);
			expect(result.status).toBe('stopped');
			expectProofReleased();
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(mockBuildAgentArgs).toHaveBeenCalledTimes(1);
			expect(onRunTranscript).not.toHaveBeenCalled();
		});

		it('keeps cancellation ahead of a failed build without acquiring proof ownership', async () => {
			const controller = new AbortController();
			mockGetAgentDefinition.mockReturnValue(null);
			buildBoundary.afterBuild = (result) => {
				expect(result.ok).toBe(false);
				void Promise.resolve().then(() => controller.abort());
			};
			const result = await executeCuePrompt(createExecutionConfig({ signal: controller.signal }));
			expect(result).toMatchObject({ status: 'stopped', stderr: '' });
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(revoke).not.toHaveBeenCalled();
			expect(removeProof).not.toHaveBeenCalled();
		});

		it.each(['logging', 'heartbeat'] as const)(
			'releases proofs when %s setup throws before execution',
			async (stage) => {
				const failure = new Error(privateContent);
				const config = createExecutionConfig();
				if (stage === 'logging')
					config.onLog = vi.fn(() => {
						throw failure;
					});
				else
					vi.spyOn(wakaTime, 'getWakaTimeManager').mockImplementation(() => {
						throw failure;
					});
				await expect(executeCuePrompt(config)).rejects.toBe(failure);
				expectProofReleased();
				expect(mockSpawn).not.toHaveBeenCalled();
			}
		);

		it('releases proofs when exclusive local prompt preparation fails without retry or private diagnostics', async () => {
			const promptFile = path.resolve('private-cue-prompt.json');
			const attachProof = buildBoundary.afterBuild!;
			buildBoundary.afterBuild = (result) => {
				attachProof(result);
				if (!result.ok) return;
				result.spec.args = ['--prompt-file', promptFile];
				result.spec.promptArtifact = {
					owner: 'local',
					path: promptFile,
					content: privateContent,
					encoding: 'utf8',
					mode: 0o600,
					flag: 'wx',
					cleanup: 'turn',
				};
			};
			const open = vi.spyOn(fs, 'openSync').mockImplementation(() => {
				throw new Error(`${promptFile}: ${privateContent}`);
			});
			const config = createExecutionConfig();
			const result = await executeCuePrompt(config);
			expect(open).toHaveBeenCalledExactlyOnceWith(promptFile, 'wx', 0o600);
			expect(result).toMatchObject({
				status: 'failed',
				stderr: 'Spawn error: Prompt-file launch failed.',
			});
			expectProofReleased();
			expect(mockSpawn).not.toHaveBeenCalled();
			expect(mockBuildAgentArgs).toHaveBeenCalledTimes(1);
			const diagnostics = JSON.stringify([
				result,
				vi.mocked(config.onLog).mock.calls,
				warn.mock.calls,
			]);
			for (const privateValue of [promptFile, privateContent, proofFile, token!])
				expect(diagnostics).not.toContain(privateValue);
		});

		it.each([0, 7])('releases proofs before the transcript after exit %i', async (exitCode) => {
			const onRunTranscript = vi.fn();
			const pending = executeCuePrompt(createExecutionConfig({ onRunTranscript }));
			await vi.advanceTimersByTimeAsync(0);
			expect(proofIdentity.pluginToolRunIdentity.resolve(token).callerAgentId).toBe('session-1');
			expect(ownedFiles.has(proofFile)).toBe(true);
			mockChild.emit('close', exitCode);
			const result = await pending;
			expect(result).toMatchObject({ exitCode, status: exitCode === 0 ? 'completed' : 'failed' });
			expectProofReleased();
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(onRunTranscript).toHaveBeenCalledTimes(1);
			expect(removeProof.mock.invocationCallOrder[0]).toBeLessThan(
				onRunTranscript.mock.invocationCallOrder[0]
			);
		});

		it('reports cleanup failure without private proof paths, tokens or prompt content', async () => {
			removeProof.mockImplementation(() => {
				throw new Error(`${proofFile}: ${token} ${privateContent}`);
			});
			const config = createExecutionConfig({ promptPath: privateContent });
			const pending = executeCuePrompt(config);
			await vi.advanceTimersByTimeAsync(0);
			mockChild.emit('close', 0);
			const result = await pending;
			expect(result.status).toBe('completed');
			expect(revoke).toHaveBeenCalledExactlyOnceWith(token);
			expect(proofIdentity.pluginToolRunIdentity.resolve(token).callerAgentId).toBeNull();
			expect(removeProof).toHaveBeenCalledExactlyOnceWith(proofFile);
			expect(warn).toHaveBeenCalledExactlyOnceWith(
				'Could not remove plugin run proof file',
				'[PluginRunIdentity]'
			);
			const diagnostics = JSON.stringify([
				result,
				vi.mocked(config.onLog).mock.calls,
				warn.mock.calls,
			]);
			for (const privateValue of [proofFile, token!, privateContent])
				expect(diagnostics).not.toContain(privateValue);
		});

		it('finishes an ordinary no-proof run without attempting proof cleanup', async () => {
			buildBoundary.afterBuild = undefined;
			const pending = executeCuePrompt(createExecutionConfig());
			await vi.advanceTimersByTimeAsync(0);
			mockChild.emit('close', 0);
			expect((await pending).status).toBe('completed');
			expect(mockSpawn).toHaveBeenCalledTimes(1);
			expect(revoke).not.toHaveBeenCalled();
			expect(removeProof).not.toHaveBeenCalled();
		});
	});
});
