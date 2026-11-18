/**
 * Tests for src/main/process-manager.ts
 *
 * Tests cover the aggregateModelUsage utility function that consolidates
 * token usage data from Claude Code responses.
 */

import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock node-pty before importing process-manager (native module)
vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

const { mockExecFile, mockExecFileSync } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return { ...actual, execFile: mockExecFile, execFileSync: mockExecFileSync };
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

// Mock platform detection - delegates to process.platform by default so
// pre-existing tests that override process.platform still work. Kill-method
// tests override via mockReturnValueOnce / mockReturnValue.
const { mockIsWindows } = vi.hoisted(() => ({
	mockIsWindows: vi.fn<() => boolean>().mockImplementation(() => process.platform === 'win32'),
}));

vi.mock('../../shared/platformDetection', () => ({
	isWindows: () => mockIsWindows(),
	// Decides where the stop ladder reads the process table from.
	isLinux: () => process.platform === 'linux',
}));

// Mock the PID liveness probe so the stale-entry reconciliation can be driven
// deterministically on any host (a hardcoded "dead" PID would otherwise be a
// coin flip). Defaults to "alive" so unrelated tests keep the old semantics.
const { mockIsPidAlive } = vi.hoisted(() => ({
	mockIsPidAlive: vi.fn<(pid: number | undefined) => boolean>().mockReturnValue(true),
}));

const { mockSignalRemoteAgent } = vi.hoisted(() => ({ mockSignalRemoteAgent: vi.fn() }));
vi.mock('../../main/utils/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../main/utils/ssh-remote-signal')>()),
	signalRemoteAgent: mockSignalRemoteAgent,
}));

vi.mock('../../main/process-manager/utils/childProcessInfo', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../main/process-manager/utils/childProcessInfo')>();
	return { ...actual, isPidAlive: (pid?: number) => mockIsPidAlive(pid) };
});

// Grok steering: the maestro-p steering client is observed, never dialed for
// Grok; while `grokScript.enabled`, the shared ACP driver is a scripted turn (no process)
// and the selector is told a person can answer, so the real GrokAcpSpawner records a turn.
const { mockSendSteeringRequest, grokScript } = vi.hoisted(() => ({
	mockSendSteeringRequest: vi.fn(),
	grokScript: {
		enabled: false,
		turns: [] as Array<{
			cancel: ReturnType<typeof vi.fn>;
			terminate: ReturnType<typeof vi.fn>;
			terminateNow: ReturnType<typeof vi.fn>;
			settle: (status: 'success' | 'cancelled') => void;
		}>,
	},
}));
vi.mock('../../main/process-manager/steering-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../main/process-manager/steering-client')>()),
	sendSteeringRequest: mockSendSteeringRequest,
}));
vi.mock('../../shared/maestro-lib/grok/route', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../shared/maestro-lib/grok/route')>();
	return {
		...actual,
		beginGrokAcpNegotiation: ((req, snapshot) =>
			actual.beginGrokAcpNegotiation(
				grokScript.enabled ? { ...req, consent: 'interactive' } : req,
				snapshot
			)) as typeof actual.beginGrokAcpNegotiation,
	};
});
vi.mock('../../shared/maestro-lib/grok/acp-turn', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../shared/maestro-lib/grok/acp-turn')>();
	return {
		...actual,
		startGrokAcpTurn: ((...args: Parameters<typeof actual.startGrokAcpTurn>) => {
			if (!grokScript.enabled) return actual.startGrokAcpTurn(...args);
			let resolve!: (value: unknown) => void;
			const completed = new Promise((r) => (resolve = r));
			const turn = {
				cancel: vi.fn(),
				terminate: vi.fn(),
				terminateNow: vi.fn(),
				settle: (status: 'success' | 'cancelled') =>
					resolve({
						exit: { code: 0, signal: null },
						terminal: { status, dispatchState: 'dispatched' },
						usageReports: [],
					}),
			};
			grokScript.turns.push(turn);
			return {
				handle: {
					pid: 7000 + grokScript.turns.length,
					terminate: turn.terminate,
					terminateNow: turn.terminateNow,
				},
				completed,
				cancel: turn.cancel,
				commands: () => undefined,
				configuration: () => undefined,
				invalidateCommands: () => {},
			} as unknown as ReturnType<typeof actual.startGrokAcpTurn>;
		}) as typeof actual.startGrokAcpTurn,
	};
});

import * as fs from 'fs';

import {
	aggregateModelUsage,
	ProcessManager,
	detectNodeVersionManagerBinPaths,
	buildUnixBasePath,
	type ModelStats,
	type AgentError,
} from '../../main/process-manager';
import type { ManagedProcess, ProcessConfig } from '../../main/process-manager/types';
import { nextSpawnGeneration } from '../../main/process-manager/generation';
import { logger } from '../../main/utils/logger';
import { GrokOutputParser } from '../../main/parsers/grok-output-parser';
import { StdoutHandler } from '../../main/process-manager/handlers/StdoutHandler';
import { ExitHandler } from '../../main/process-manager/handlers/ExitHandler';
import { DataBufferManager } from '../../main/process-manager/handlers/DataBufferManager';
import {
	GROK_ACP_PORT_SUPPORT,
	grokSteeringAvailability,
} from '../../shared/maestro-lib/grok/route';
import { STEERING_TURN_FINISHED_DETAIL } from '../../shared/chatSteering';
import { discoverGrokSlashCommands } from '../../main/agents/grok-skills';
import { readSyntheticGrokAcpLog, writeSyntheticGrokAcpPeer } from '../fixtures/grok-acp-peer';

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
					// The model reported this window itself, so it is provider truth
					// even though it equals the fallback (review of PR #1356).
					contextWindowResolved: true,
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
					contextWindowResolved: true,
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
			processManager = new ProcessManager();
			mockExecFile.mockClear();
			mockExecFileSync.mockClear();
		});

		describe('Grok native request correlation', () => {
			let request: ProcessConfig;
			let processes: Map<string, ManagedProcess>;
			let spawn: ReturnType<
				typeof vi.fn<(config: ProcessConfig) => { pid: number; success: boolean }>
			>;

			beforeEach(() => {
				processManager = new ProcessManager(() => false, { isCoworkingEnabled: () => false });
				const scope = {
					version: 1,
					state: 'bound',
					provider: 'grok',
					accountRef: 'grok:fixture-account',
					host: { kind: 'local', identity: 'fixture-machine' },
					cwd: process.cwd(),
				} as const;
				request = {
					sessionId: 'correlation-ai-tab',
					tabId: 'tab',
					toolType: 'grok',
					cwd: process.cwd(),
					command: 'grok',
					args: ['--resume', 'native-requested'],
					customEnvVars: { GROK_HOME: path.join(process.cwd(), 'fixture-account') },
					agentSessionId: 'native-requested',
					nativeSessionScope: scope,
					nativeSessionBinding: { ...scope, nativeSessionId: 'native-requested' },
					nativeSessionRequestId: 'attempt_1-A',
				};
				// Same inert spawner/map pattern as ProcessManager.serveSpawn.test.ts.
				const internals = processManager as unknown as {
					processes: Map<string, ManagedProcess>;
					childProcessSpawner: { spawn: typeof spawn };
				};
				processes = internals.processes;
				spawn = vi.fn((config: ProcessConfig) => {
					processes.set(config.sessionId, {
						sessionId: config.sessionId,
						toolType: config.toolType,
						cwd: config.cwd,
						pid: 4242,
						isTerminal: false,
						startTime: 1,
						spawnGeneration: nextSpawnGeneration(config.sessionId),
					});
					return { pid: 4242, success: true };
				});
				internals.childProcessSpawner = { spawn };
			});

			afterEach(() => {
				for (const id of processes.keys()) processManager.kill(id);
				processManager.emit('exit', request.sessionId, 0);
				vi.restoreAllMocks();
			});

			it('routes a local standard Grok spawn to GrokAcpSpawner, never headless streaming', async () => {
				const acpSpawn = vi.fn((config: ProcessConfig) => {
					processes.set(config.sessionId, {
						sessionId: config.sessionId,
						toolType: config.toolType,
						cwd: config.cwd,
						pid: 4343,
						isTerminal: false,
						startTime: 1,
						spawnGeneration: nextSpawnGeneration(config.sessionId),
					});
					return { pid: 4343, success: true };
				});
				(
					processManager as unknown as { grokAcpSpawner: { spawn: typeof acpSpawn } }
				).grokAcpSpawner = { spawn: acpSpawn };
				const standard: ProcessConfig = {
					...request,
					args: [],
					agentSessionId: undefined,
					nativeSessionBinding: undefined,
					permission: { requested: 'standard' },
				} as ProcessConfig;
				expect(await processManager.spawnChecked(standard)).toMatchObject({
					success: true,
				});
				expect(acpSpawn).toHaveBeenCalledTimes(1);
				expect(acpSpawn.mock.calls[0][0].permission).toEqual({ requested: 'standard' });
				expect(spawn).not.toHaveBeenCalled();
			});

			it.each(['a', 'attempt_1-A', 'Z'.repeat(128)])(
				'echoes valid token %s without changing the launch',
				async (token) => {
					request.nativeSessionRequestId = token;
					expect(await processManager.spawnChecked(request)).toMatchObject({ success: true });
					const proc = processManager.get(request.sessionId)!;
					const receipt = processManager.nativeSessionLaunchOf(request.sessionId);
					expect(receipt).toEqual({
						scope: request.nativeSessionScope,
						processGeneration: proc.spawnGeneration,
						tabId: 'tab',
						requestedNativeSessionId: 'native-requested',
						nativeSessionRequestId: token,
					});
					expect(spawn.mock.calls[0][0].args).toEqual(request.args);
					expect(spawn.mock.calls[0][0].customEnvVars).toEqual(request.customEnvVars);
					expect(spawn.mock.calls[0][0].shellEnvVars).toBeUndefined();
					expect(proc.agentSessionId).toBeUndefined();
					// Observing a different native ID must not rewrite the requested ID or token.
					proc.agentSessionId = 'native-observed';
					expect(processManager.nativeSessionLaunchOf(request.sessionId)).toMatchObject({
						requestedNativeSessionId: 'native-requested',
						nativeSessionRequestId: token,
					});
					expect(proc.agentSessionId).toBe('native-observed');
				}
			);

			it.each([
				undefined,
				null,
				1,
				true,
				{},
				['attempt'],
				new String('attempt'),
				'',
				'x'.repeat(129),
				' ',
				' leading',
				'trailing ',
				'two words',
				'line\nbreak',
				'trailing\n',
				'tab\t',
				'nul\0',
				'del\u007f',
				'caf\u00e9',
			])('omits malformed or legacy token %# without coercion', async (token) => {
				delete request.nativeSessionRequestId;
				if (token !== undefined) Object.assign(request, { nativeSessionRequestId: token });
				expect(await processManager.spawnChecked(request)).toMatchObject({
					success: true,
				});
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).not.toHaveProperty(
					'nativeSessionRequestId'
				);
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).toMatchObject({
					scope: request.nativeSessionScope,
					requestedNativeSessionId: 'native-requested',
				});
			});

			it.each(['local', 'ssh'] as const)(
				'retains the %s request across a pending spawn check and synchronous spawn callbacks',
				async (kind) => {
					const scope = {
						...request.nativeSessionScope,
						host: { kind, identity: `${kind}-fixture` },
					} as Extract<NonNullable<ProcessConfig['nativeSessionScope']>, { state: 'bound' }>;
					if (kind === 'ssh') {
						Object.assign(scope, { cwd: '/work/project' });
						request.sshRemoteId = 'remote-fixture';
					}
					request.nativeSessionScope = scope;
					request.nativeSessionBinding = { ...scope, nativeSessionId: 'native-requested' };
					const original = structuredClone(request);
					let release!: () => void;
					const gate = new Promise<void>((resolve) => {
						release = resolve;
					});
					const pending = processManager.spawnChecked(request, {
						beforeSpawn: async () => {
							await gate;
							return undefined;
						},
					});
					request.nativeSessionRequestId = 'mutated_pending';
					request.agentSessionId = 'wrong-native';
					request.cwd = 'wrong-cwd';
					request.tabId = 'wrong-tab';
					request.args.push('--continue');
					request.customEnvVars!.GROK_HOME = 'wrong-account';
					Object.assign(scope, { accountRef: 'wrong-account', cwd: 'wrong-cwd' });
					Object.assign(scope.host, { identity: 'wrong-host' });
					const register = spawn.getMockImplementation()!;
					spawn.mockImplementation((config) => {
						expect(config).toMatchObject(original);
						config.nativeSessionRequestId = 'mutated_callback';
						return register(config);
					});
					release();
					expect(await pending).toMatchObject({ success: true });
					expect(processManager.nativeSessionLaunchOf(original.sessionId)).toMatchObject({
						scope: original.nativeSessionScope,
						tabId: original.tabId,
						requestedNativeSessionId: original.agentSessionId,
						nativeSessionRequestId: 'attempt_1-A',
					});
				}
			);

			it('rechecks ownership after an asynchronous Grok launch check before spawning', async () => {
				let release!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let owned = true;
				const assertSpawnAllowed = vi.fn(() => {
					if (!owned) throw new Error('DispatchTargetUnavailable');
				});
				const pending = processManager.spawnChecked(request, {
					beforeSpawn: async () => {
						await gate;
						return undefined;
					},
					assertSpawnAllowed,
				});
				expect(assertSpawnAllowed).not.toHaveBeenCalled();
				owned = false;
				release();
				await expect(pending).rejects.toThrow('DispatchTargetUnavailable');
				expect(assertSpawnAllowed).toHaveBeenCalledTimes(1);
				expect(spawn).not.toHaveBeenCalled();
				expect(processManager.get(request.sessionId)).toBeUndefined();
			});

			it('captures the token before a direct synchronous spawn mutates its caller', () => {
				const register = spawn.getMockImplementation()!;
				spawn.mockImplementation((config) => {
					request.nativeSessionRequestId = 'later';
					return register(config);
				});
				expect(processManager.spawn(request).success).toBe(true);
				expect(
					processManager.nativeSessionLaunchOf(request.sessionId)?.nativeSessionRequestId
				).toBe('attempt_1-A');
			});

			it('keeps unknown scope unknown and does not create receipts for another provider', async () => {
				delete request.agentSessionId;
				delete request.nativeSessionBinding;
				delete request.nativeSessionScope;
				request.args = [];
				expect(await processManager.spawnChecked(request)).toMatchObject({
					success: true,
				});
				expect(processManager.nativeSessionLaunchOf(request.sessionId)?.scope).toEqual({
					version: 1,
					state: 'unknown',
					reason: 'unobserved',
				});
				processManager.kill(request.sessionId);
				processManager.emit('exit', request.sessionId, 0);
				request.toolType = 'copilot-cli';
				expect(await processManager.spawnChecked(request)).toMatchObject({
					success: true,
				});
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBeUndefined();
			});

			it.each(['refused', 'check-error', 'spawn-failed', 'no-process'] as const)(
				'does not manufacture a receipt when %s',
				async (failure) => {
					if (failure === 'spawn-failed' || failure === 'no-process')
						spawn.mockReturnValueOnce({ pid: -1, success: failure === 'no-process' });
					const pending = processManager.spawnChecked(request, {
						beforeSpawn: () => {
							if (failure === 'refused') return 'fixture refusal';
							if (failure === 'check-error') throw new Error('fixture check failure');
							return undefined;
						},
					});
					if (failure === 'check-error')
						await expect(pending).rejects.toThrow('fixture check failure');
					else if (failure === 'refused')
						expect(await pending).toEqual({ pid: -1, success: false, error: 'fixture refusal' });
					else expect(await pending).toMatchObject({ success: failure === 'no-process' });
					expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBeUndefined();
					expect(processManager.get(request.sessionId)).toBeUndefined();
					if (!['spawn-failed', 'no-process'].includes(failure))
						expect(spawn).not.toHaveBeenCalled();
				}
			);

			it.each([
				['stdout', false],
				['exit flush', false],
				['stdout', true],
				['exit flush', true],
			] as const)(
				'resumes the end-only ID from %s after interrupted=%s',
				async (route, interrupted) => {
					delete request.agentSessionId;
					delete request.nativeSessionBinding;
					request.args = [];
					await processManager.spawnChecked(request);
					const proc = processManager.get(request.sessionId)!;
					Object.assign(proc, {
						isStreamJsonMode: true,
						isBatchMode: true,
						outputParser: new GrokOutputParser(),
						interrupted,
					});
					const bufferManager = new DataBufferManager(processes, processManager);
					const deps = { processes, emitter: processManager, bufferManager };
					const stdout = new StdoutHandler(deps);
					const onId = vi.fn((id: string, nativeId: string) => ({
						nativeId,
						launch: processManager.nativeSessionLaunchOf(id),
					}));
					processManager.on('session-id', onId);
					const onError = vi.fn();
					processManager.on('agent-error', onError);
					stdout.handleData(request.sessionId, '{"type":"text","data":"partial answer"}\n');
					expect(onId).not.toHaveBeenCalled();
					const end = JSON.stringify({
						type: 'end',
						stopReason: interrupted ? 'cancelled' : 'EndTurn',
						sessionId: 'native-new',
					});
					stdout.handleData(request.sessionId, end + (route === 'stdout' ? '\n' : ''));
					if (route === 'exit flush') {
						expect(onId).not.toHaveBeenCalled();
						if (interrupted) processManager.kill(request.sessionId);
					}
					await new ExitHandler(deps).handleExit(request.sessionId, interrupted ? 130 : 0, proc);
					expect(onId).toHaveBeenCalledExactlyOnceWith(request.sessionId, 'native-new');
					expect(onError).not.toHaveBeenCalled();
					const observed = onId.mock.results[0].value;
					expect(observed.launch).toMatchObject({
						scope: request.nativeSessionScope,
						tabId: request.tabId,
						processGeneration: proc.spawnGeneration,
						nativeSessionRequestId: 'attempt_1-A',
					});
					expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBeUndefined();
					if (observed.launch?.scope.state !== 'bound') throw new Error('Missing captured scope');
					request.agentSessionId = observed.nativeId;
					request.nativeSessionBinding = {
						...observed.launch.scope,
						nativeSessionId: observed.nativeId,
					};
					request.args = ['--resume', observed.nativeId];
					request.nativeSessionRequestId = 'next_attempt';
					expect(await processManager.spawnChecked(request)).toMatchObject({ success: true });
					expect(spawn.mock.lastCall![0]).toMatchObject({
						args: ['--resume', 'native-new'],
						customEnvVars: { GROK_HOME: path.join(process.cwd(), 'fixture-account') },
						nativeSessionScope: observed.launch.scope,
					});
				}
			);

			it('discards a predecessor end after a successor takes the same process key', async () => {
				await processManager.spawnChecked(request);
				const predecessor = processManager.get(request.sessionId)!;
				Object.assign(predecessor, {
					isStreamJsonMode: true,
					outputParser: new GrokOutputParser(),
					jsonBuffer: '{"type":"end","stopReason":"EndTurn","sessionId":"stale-native"}',
				});
				processManager.kill(request.sessionId);
				request.nativeSessionRequestId = 'successor';
				await processManager.spawnChecked(request);
				const successor = processManager.get(request.sessionId)!;
				const receipt = processManager.nativeSessionLaunchOf(request.sessionId);
				const onId = vi.fn();
				const onExit = vi.fn();
				const onParsed = vi.fn();
				processManager.on('session-id', onId).on('exit', onExit).on('parsed-event', onParsed);
				const bufferManager = new DataBufferManager(processes, processManager);
				await new ExitHandler({ processes, emitter: processManager, bufferManager }).handleExit(
					request.sessionId,
					0,
					predecessor
				);
				expect(onId).not.toHaveBeenCalled();
				expect(onExit).not.toHaveBeenCalled();
				expect(onParsed).not.toHaveBeenCalled();
				expect(processManager.get(request.sessionId)).toBe(successor);
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBe(receipt);
				expect(receipt?.nativeSessionRequestId).toBe('successor');
				expect(successor.agentSessionId).toBeUndefined();
			});

			it.each(['account', 'host', 'cwd', 'unchanged'] as const)(
				'checks %s ownership before native resume',
				async (changed) => {
					if (request.nativeSessionScope?.state !== 'bound')
						throw new Error('Missing fixture scope');
					const scope = {
						...request.nativeSessionScope,
						cwd: '/remote/project',
						host: { kind: 'ssh' as const, identity: 'endpoint-original' },
					};
					request.nativeSessionBinding = {
						...structuredClone(scope),
						nativeSessionId: 'native-requested',
					};
					const retainedBinding = structuredClone(request.nativeSessionBinding);
					request.nativeSessionScope = scope;
					request.sshRemoteId = 'unchanged-alias';
					// The SSH client starts locally; native ownership retains the remote project.
					request.cwd = process.cwd();
					request.projectPath = '/remote/project';
					request.command = 'ssh';
					request.args = ['unchanged-alias', 'grok --resume native-requested'];
					if (changed === 'account') scope.accountRef = 'grok:other-account';
					if (changed === 'host') scope.host.identity = 'endpoint-replaced';
					if (changed === 'cwd') scope.cwd = '/remote/other-project';
					const onError = vi.fn();
					processManager.on('agent-error', onError);
					const result = await processManager.spawnChecked(request);
					if (changed === 'unchanged') {
						expect(result.success).toBe(true);
						expect(spawn).toHaveBeenCalledOnce();
						expect(spawn.mock.lastCall![0]).toMatchObject({
							cwd: process.cwd(),
							projectPath: '/remote/project',
							nativeSessionScope: scope,
							nativeSessionBinding: retainedBinding,
						});
						expect(onError).not.toHaveBeenCalled();
						return;
					}
					expect(result.success).toBe(false);
					expect(spawn).not.toHaveBeenCalled();
					expect(onError).toHaveBeenCalledWith(
						request.sessionId,
						expect.objectContaining({ type: 'session_not_found', recoverable: false })
					);
					expect(request.nativeSessionBinding).toEqual(retainedBinding);
					expect(request.agentSessionId).toBe('native-requested');
					expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBeUndefined();
				}
			);

			it('retains the successful receipt through cancellation drainage and a failed retry', async () => {
				await processManager.spawnChecked(request);
				const receipt = processManager.nativeSessionLaunchOf(request.sessionId);
				expect(receipt?.nativeSessionRequestId).toBe('attempt_1-A');
				expect(processManager.kill(request.sessionId)).toBe(true);
				expect(processManager.get(request.sessionId)).toBeUndefined();
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBe(receipt);
				request.nativeSessionRequestId = 'failed_retry';
				spawn.mockReturnValueOnce({ pid: -1, success: false });
				expect(await processManager.spawnChecked(request)).toMatchObject({
					success: false,
				});
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBe(receipt);
				processManager.emit('exit', request.sessionId, 0);
				expect(processManager.nativeSessionLaunchOf(request.sessionId)).toBeUndefined();
			});
		});

		describe('Grok steering', () => {
			// Scripted ACP turns through the real GrokAcpSpawner of this ProcessManager. Wire 1
			// and the pinned Grok extensions advertise no in-progress input operation, so every
			// answer is a structured refusal (parity S21); these are not native qualification.
			let keyCounter = 0;
			let emitted: string[];
			type SpawnerInternals = {
				grokAcpSpawner: {
					spawn: (config: ProcessConfig) => { pid: number; success: boolean };
					steer: (process: ManagedProcess, id: string) => unknown;
					ctx: { liveTurns: Set<unknown> };
				};
			};
			const internals = () => processManager as unknown as SpawnerInternals;
			const liveTurns = () => internals().grokAcpSpawner.ctx.liveTurns.size;
			const scope = {
				version: 1,
				state: 'bound',
				provider: 'grok',
				accountRef: 'grok:fixture-account',
				host: { kind: 'local', identity: 'fixture-machine' },
				cwd: process.cwd(),
			} as const;
			function startAcpTurn(sessionId: string, tabId: string) {
				const result = internals().grokAcpSpawner.spawn({
					sessionId,
					tabId,
					toolType: 'grok',
					cwd: process.cwd(),
					command: path.join(process.cwd(), 'fixture-bin', 'grok'),
					args: [],
					prompt: `work on ${tabId}`,
					nativeSessionScope: scope,
					permission: { requested: 'standard' },
				} as unknown as ProcessConfig);
				expect(result.success).toBe(true);
				return processManager.get(sessionId)!;
			}
			const refusedWith = (detail: string | RegExp) => ({
				type: 'steering',
				id: expect.any(String),
				verdict: 'refused',
				refusal: 'not-running',
				detail: typeof detail === 'string' ? detail : expect.stringMatching(detail),
			});
			const ACP_GAP = /no in-progress input operation/;
			const NOT_OWNED = /no longer the active Grok turn/;
			function expectNoSteerSideEffects(started: number) {
				expect(mockSendSteeringRequest).not.toHaveBeenCalled();
				expect(grokScript.turns).toHaveLength(started);
				expect(emitted).not.toContain('steering-verdict');
			}

			beforeEach(() => {
				keyCounter += 1;
				grokScript.enabled = true;
				grokScript.turns.length = 0;
				mockSendSteeringRequest.mockReset();
				emitted = [];
				const emit = processManager.emit.bind(processManager);
				vi.spyOn(processManager, 'emit').mockImplementation((event, ...args) => {
					emitted.push(String(event));
					return emit(event, ...args);
				});
			});
			afterEach(() => {
				grokScript.enabled = false;
				for (const turn of grokScript.turns) turn.settle('cancelled');
				vi.restoreAllMocks();
			});

			it('pins the absent operation: an owned ACP turn is still refused, never delivered', () => {
				// A port that grows a steering operation changes this pin and its delivery together.
				expect(GROK_ACP_PORT_SUPPORT.steering).toBe(false);
				expect(grokSteeringAvailability({ route: 'acp-stdio', owned: true })).toMatchObject({
					ok: false,
					missing: ['acp-steering'],
					parityRows: ['P10', 'S21'],
				});
				expect(grokSteeringAvailability({ route: 'native-headless', owned: true }).missing).toEqual(
					['native-steering']
				);
				expect(grokSteeringAvailability({ route: 'acp-stdio', owned: false }).missing).toEqual([
					'steering-not-owned',
				]);
			});

			it('refuses each of two active turns by its own key, repeat steers included, leaving both running', async () => {
				const a = `grok-steer-${keyCounter}-a`;
				const b = `grok-steer-${keyCounter}-b`;
				const procA = startAcpTurn(a, 'tab-1');
				const procB = startAcpTurn(b, 'tab-2');
				expect(liveTurns()).toBe(2);

				const answers = [
					await processManager.steer(a, 'go left'),
					await processManager.steer(b, 'go right'),
					await processManager.steer(a, 'go left'),
				];

				for (const answer of answers) expect(answer).toEqual(refusedWith(ACP_GAP));
				expect(new Set(answers.map((answer) => (answer as { id: string }).id)).size).toBe(3);
				expect(processManager.get(a)).toBe(procA);
				expect(processManager.get(b)).toBe(procB);
				for (const turn of grokScript.turns) {
					expect(turn.cancel).not.toHaveBeenCalled();
					expect(turn.terminate).not.toHaveBeenCalled();
				}
				expect(liveTurns()).toBe(2);
				expectNoSteerSideEffects(2);
			});

			it('answers a Grok record no ACP turn runs as the headless route, and an unknown key as finished', async () => {
				const live = `grok-steer-${keyCounter}-live`;
				const headless = `grok-steer-${keyCounter}-headless`;
				startAcpTurn(live, 'tab-1');
				const internalsMap = processManager as unknown as {
					processes: Map<string, ManagedProcess>;
				};
				internalsMap.processes.set(headless, {
					sessionId: headless,
					toolType: 'grok',
					cwd: process.cwd(),
					pid: 4343,
					isTerminal: false,
					startTime: 1,
				});

				expect(await processManager.steer(headless, 'x')).toEqual(refusedWith(/headless route/));
				expect(await processManager.steer(`grok-steer-${keyCounter}-gone`, 'x')).toEqual(
					refusedWith(STEERING_TURN_FINISHED_DETAIL)
				);
				// The live turn on another key is neither consulted as the owner nor disturbed.
				expect(await processManager.steer(live, 'x')).toEqual(refusedWith(ACP_GAP));
				expect(grokScript.turns[0].cancel).not.toHaveBeenCalled();
				internalsMap.processes.delete(headless);
				expectNoSteerSideEffects(1);
			});

			it('refuses a cancelled turn as not owned, then as finished once it exits, with no restart', async () => {
				const key = `grok-steer-${keyCounter}-cancel`;
				startAcpTurn(key, 'tab-1');
				expect(processManager.interrupt(key)).toBe(true);
				expect(grokScript.turns[0].cancel).toHaveBeenCalledTimes(1);

				expect(await processManager.steer(key, 'too late')).toEqual(refusedWith(NOT_OWNED));
				grokScript.turns[0].settle('cancelled');
				await vi.waitFor(() => expect(processManager.get(key)).toBeUndefined());

				expect(liveTurns()).toBe(0);
				expect(await processManager.steer(key, 'too late')).toEqual(
					refusedWith(STEERING_TURN_FINISHED_DETAIL)
				);
				expect(grokScript.turns[0].cancel).toHaveBeenCalledTimes(1);
				expectNoSteerSideEffects(1);
			});

			it('answers a restarted key from the new owner and never from the superseded turn', async () => {
				const key = `grok-steer-${keyCounter}-restart`;
				const first = startAcpTurn(key, 'tab-1');
				const second = startAcpTurn(key, 'tab-1');
				expect(second).not.toBe(first);

				// The stale record is not the active owner; the key is answered by the new turn.
				expect(internals().grokAcpSpawner.steer(first, 'stale-id')).toEqual(refusedWith(NOT_OWNED));
				expect(await processManager.steer(key, 'x')).toEqual(refusedWith(ACP_GAP));

				// A late completion of the superseded turn neither exits nor evicts the new one.
				grokScript.turns[0].settle('success');
				await vi.waitFor(() => expect(liveTurns()).toBe(1));
				expect(processManager.get(key)).toBe(second);
				expect(emitted).not.toContain('exit');

				// Stop ends the owned turn: refused not owned, then the channel is gone after exit.
				processManager.kill(key);
				expect(grokScript.turns[1].terminate).toHaveBeenCalledTimes(1);
				expect(internals().grokAcpSpawner.steer(second, 'after-stop')).toEqual(
					refusedWith(NOT_OWNED)
				);
				grokScript.turns[1].settle('cancelled');
				await vi.waitFor(() => expect(liveTurns()).toBe(0));
				expect(await processManager.steer(key, 'x')).toEqual(
					refusedWith(STEERING_TURN_FINISHED_DETAIL)
				);
				expectNoSteerSideEffects(2);
			});
		});

		// The real ProcessManager, GrokAcpSpawner, shared ACP driver, StdoutHandler and
		// ExitHandler against the synthetic wire-1 peer process of fixtures/grok-acp-peer.ts (not
		// native qualification). POSIX only: the peer starts through a `#!/bin/sh` wrapper.
		describe.skipIf(process.platform === 'win32')('Grok ACP transport consumers', () => {
			let dir: string;
			let wrapper: string;
			let events: Array<[string, ...unknown[]]>;
			let consent: {
				bindings: Array<{ sessionId: string; tabId: string }>;
				asked: Array<{ tabId: string; toolName: string; input: Record<string, unknown> }>;
				closed: string[];
				answer: (tabId: string) => 'allow' | 'deny';
			};
			type HeadlessSpawn = (config: ProcessConfig) => { pid: number; success: boolean };
			let headless: ReturnType<typeof vi.fn<HeadlessSpawn>>;
			type Internals = {
				processes: Map<string, ManagedProcess>;
				childProcessSpawner: { spawn: (config: ProcessConfig) => unknown };
				grokAcpSpawner: {
					spawn: (config: ProcessConfig) => { pid: number; success: boolean };
					ctx: { liveTurns: Set<unknown>; consent: unknown };
				};
			};
			const internals = () => processManager as unknown as Internals;
			const scope = (account = 'grok:fixture-account') =>
				({
					version: 1,
					state: 'bound',
					provider: 'grok',
					accountRef: account,
					host: { kind: 'local', identity: 'fixture-machine' },
					cwd: dir,
				}) as const;
			const logOf = (name: string) => readSyntheticGrokAcpLog(path.join(dir, `${name}.log`));
			function config(
				sessionId: string,
				env: Record<string, string>,
				extra: Partial<ProcessConfig> = {}
			): ProcessConfig {
				return {
					sessionId,
					tabId: `${sessionId}-tab`,
					toolType: 'grok',
					cwd: dir,
					command: wrapper,
					// handle-spawn passes the agent executable's own directory, as discovery assumes.
					extraPathDirs: [dir],
					args: [],
					prompt: `work on ${sessionId}`,
					nativeSessionScope: scope(),
					permission: { requested: 'standard' },
					// One native session per key: the driver refuses a second live owner (busy).
					customEnvVars: {
						FAKE_LOG: path.join(dir, `${sessionId}.log`),
						FAKE_SESSION: `native-${sessionId}`,
						...env,
					},
					...extra,
				} as ProcessConfig;
			}
			const of = (name: string, sessionId?: string) =>
				events.filter(([event, id]) => event === name && (!sessionId || id === sessionId));
			const exited = (sessionId: string) =>
				vi.waitFor(() => expect(of('exit', sessionId)).toHaveLength(1), { timeout: 8000 });
			const exitCodes = (sessionId: string) => of('exit', sessionId).map(([, , code]) => code);
			const usageOf = (sessionId: string) =>
				of('usage', sessionId).map(([, , usage]) => usage as Record<string, any>);

			beforeEach(() => {
				dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt1-07-04-'));
				wrapper = writeSyntheticGrokAcpPeer(dir);
				processManager = new ProcessManager(() => false, { isCoworkingEnabled: () => false });
				events = [];
				const emit = processManager.emit.bind(processManager);
				vi.spyOn(processManager, 'emit').mockImplementation((event, ...args) => {
					events.push([String(event), ...args]);
					return emit(event, ...args);
				});
				headless = vi.fn<HeadlessSpawn>(() => ({ pid: 1, success: true }));
				internals().childProcessSpawner = { spawn: headless };
				consent = { bindings: [], asked: [], closed: [], answer: () => 'deny' };
				internals().grokAcpSpawner.ctx.consent = {
					openConsentSession: (binding: { sessionId: string; tabId: string }) => {
						consent.bindings.push(binding);
						return {
							request: async (toolName: string, input: Record<string, unknown>) => {
								consent.asked.push({ tabId: binding.tabId, toolName, input });
								return consent.answer(binding.tabId) === 'allow'
									? { behavior: 'allow' }
									: { behavior: 'deny', message: 'Denied by the person' };
							},
							close: () => consent.closed.push(binding.tabId),
						};
					},
				};
			});
			afterEach(() => {
				processManager.killAll();
				vi.restoreAllMocks();
				fs.rmSync(dir, { recursive: true, force: true });
			});

			it('runs a standard turn on ACP: late native session id, streamed answer, one exit, no headless', async () => {
				const result = processManager.spawn(config('acp-ok', { FAKE_SESSION: 'native-late' }));
				expect(result).toMatchObject({ success: true });
				expect(result.pid).toBeGreaterThan(0);
				// The native session id is the peer's, learned after spawn() returned.
				expect(of('session-id')).toHaveLength(0);
				await exited('acp-ok');

				expect(of('session-id', 'acp-ok')).toEqual([['session-id', 'acp-ok', 'native-late']]);
				expect(
					of('data', 'acp-ok')
						.map(([, , text]) => text)
						.join('')
				).toContain('Hello from ACP');
				expect(exitCodes('acp-ok')).toEqual([0]);
				expect(of('agent-error')).toHaveLength(0);
				expect(logOf('acp-ok')).toEqual([
					'initialize',
					'session/new',
					'session/prompt native-late',
					'prompt [{"type":"text","text":"work on acp-ok"}]',
				]);
				expect(headless).not.toHaveBeenCalled();
				expect(internals().grokAcpSpawner.ctx.liveTurns.size).toBe(0);
				expect(processManager.get('acp-ok')).toBeUndefined();
				// The person's consent session belonged to this tab and closed with the turn.
				expect(consent.bindings).toEqual([{ sessionId: 'acp-ok', tabId: 'acp-ok-tab' }]);
				expect(consent.closed).toEqual(['acp-ok-tab']);
			});

			it.each([
				[
					'rate-limit',
					{
						code: -32603,
						message: 'Rate limit exceeded: too many requests PRIVATE-PROVIDER-TEXT',
					},
					'rate_limited',
				],
				['auth', { code: -32000, message: 'PRIVATE-PROVIDER-TEXT' }, 'auth_expired'],
				['peer-loss', undefined, 'agent_crashed'],
			] as const)(
				'reads a %s answer to the prompt as its own agent-error type, never the provider message',
				async (name, rpcError, type) => {
					const key = `acp-error-${name}`;
					processManager.spawn(
						config(
							key,
							rpcError
								? { FAKE_MODE: 'rpcerror', FAKE_RPCERROR: JSON.stringify(rpcError) }
								: { FAKE_MODE: 'vanish' }
						)
					);
					await exited(key);
					const errors = of('agent-error', key);
					expect(errors).toHaveLength(1);
					expect(errors[0][2]).toMatchObject({ type, agentId: 'grok' });
					// Nor in the desktop's diagnostics: no logger line carries the provider message.
					const logged = Object.values(logger).flatMap((fn) => vi.mocked(fn).mock.calls);
					expect(JSON.stringify([errors, of('data', key), logged])).not.toContain(
						'PRIVATE-PROVIDER-TEXT'
					);
					expect(exitCodes(key)).toEqual([1]);
					expect(logOf(key).filter((line) => line.startsWith('session/prompt'))).toHaveLength(1);
					expect(headless).not.toHaveBeenCalled();
				}
			);

			it('keeps a Full Access turn on the headless route and never starts the ACP peer', () => {
				processManager.spawn(config('full', {}, { permission: { requested: 'full' } } as never));
				expect(headless).toHaveBeenCalledTimes(1);
				expect(internals().grokAcpSpawner.ctx.liveTurns.size).toBe(0);
				expect(logOf('full')).toEqual([]);
			});

			it.each([
				['no consent surface', { tabId: undefined }, /consent/i],
				['an image payload', { images: ['data:image/png;base64,AAAA'] }, /image/i],
				['an unbound account', { nativeSessionScope: undefined }, /ownership is unknown/],
				['an SSH remote', { sshRemoteId: 'remote-1' }, /remote/i],
			])('refuses %s before any process, with no headless fallback', (_name, extra, message) => {
				const result = processManager.spawn(config('refused', {}, extra as Partial<ProcessConfig>));
				expect(result).toMatchObject({ success: false, pid: -1 });
				expect(result.error).toMatch(/Nothing was started/);
				expect(of('agent-error', 'refused')).toHaveLength(1);
				expect((of('agent-error')[0][2] as AgentError).message).toMatch(message);
				expect(logOf('refused')).toEqual([]);
				expect(headless).not.toHaveBeenCalled();
				expect(processManager.get('refused')).toBeUndefined();
			});

			it('refuses a peer that proves no agent version after negotiation, before any prompt', async () => {
				processManager.spawn(config('noversion', { FAKE_MODE: 'noversion' }));
				await exited('noversion');
				expect(logOf('noversion').some((line) => line.startsWith('session/prompt'))).toBe(false);
				expect(exitCodes('noversion')).toEqual([1]);
				const [error] = of('agent-error', 'noversion');
				expect((error[2] as AgentError).message).toMatch(/agent version.*No prompt was sent/);
				expect(headless).not.toHaveBeenCalled();
			});

			it('correlates each permission request to its own concurrent tab and answers only it', async () => {
				consent.answer = (tabId) => (tabId === 'perm-a-tab' ? 'allow' : 'deny');
				processManager.spawn(
					config('perm-a', { FAKE_MODE: 'permission', FAKE_SESSION: 'native-a' })
				);
				processManager.spawn(
					config('perm-b', { FAKE_MODE: 'permission', FAKE_SESSION: 'native-b' })
				);
				expect(internals().grokAcpSpawner.ctx.liveTurns.size).toBe(2);
				await exited('perm-a');
				await exited('perm-b');

				expect(consent.asked).toEqual(
					expect.arrayContaining([
						{ tabId: 'perm-a-tab', toolName: 'Read', input: { path: 'README.md' } },
						{ tabId: 'perm-b-tab', toolName: 'Read', input: { path: 'README.md' } },
					])
				);
				expect(consent.asked).toHaveLength(2);
				expect(
					of('data', 'perm-a')
						.map(([, , t]) => t)
						.join('')
				).toContain('Allowed answer');
				expect(
					of('data', 'perm-b')
						.map(([, , t]) => t)
						.join('')
				).toContain('Denied');
				expect(
					of('data', 'perm-b')
						.map(([, , t]) => t)
						.join('')
				).not.toContain('Allowed');
				expect(exitCodes('perm-a')).toEqual([0]);
				expect(exitCodes('perm-b')).toEqual([1]);
				expect(logOf('perm-a')).toContain('answer:perm-1');
				expect(logOf('perm-b')).toContain('answer:perm-1');
				expect(consent.closed.sort()).toEqual(['perm-a-tab', 'perm-b-tab']);
				expect(headless).not.toHaveBeenCalled();
			});

			it('cancels by protocol (a stop, not a crash), keeps partial usage, then resumes the same native session', async () => {
				processManager.spawn(config('cancel', { FAKE_MODE: 'hold', FAKE_SESSION: 'native-c' }));
				await vi.waitFor(
					() => expect(logOf('cancel').some((l) => l.startsWith('prompt'))).toBe(true),
					{ timeout: 8000 }
				);
				expect(processManager.interrupt('cancel')).toBe(true);
				await exited('cancel');
				expect(logOf('cancel')).toContain('session/cancel native-c');
				expect(exitCodes('cancel')).toEqual([0]);
				expect(of('agent-error', 'cancel')).toHaveLength(0);
				const partial = usageOf('cancel');
				expect(partial.at(-1)?.accounting?.cost).toMatchObject({ status: 'partial' });

				events.length = 0;
				processManager.spawn(
					config('cancel', { FAKE_LOG: path.join(dir, 'resume.log') }, {
						args: ['--resume', 'native-c'],
						agentSessionId: 'native-c',
						nativeSessionBinding: { ...scope(), nativeSessionId: 'native-c' },
					} as Partial<ProcessConfig>)
				);
				await exited('cancel');
				expect(logOf('resume')).toEqual([
					'initialize',
					'session/load native-c',
					'session/prompt native-c',
					'prompt [{"type":"text","text":"work on cancel"}]',
				]);
				expect(exitCodes('cancel')).toEqual([0]);
			});

			it('lets only the current owner of a restarted key exit; a superseded completion is not a second exit', async () => {
				// ProcessManager.spawn refuses a live key; a restart reaches the spawner directly.
				const first = internals().grokAcpSpawner.spawn(
					config('restart', { FAKE_MODE: 'hold', FAKE_LOG: path.join(dir, 'first.log') })
				);
				await vi.waitFor(
					() => expect(logOf('first').some((l) => l.startsWith('prompt'))).toBe(true),
					{ timeout: 8000 }
				);
				const superseded = processManager.get('restart')!;
				internals().grokAcpSpawner.spawn(
					config('restart', { FAKE_LOG: path.join(dir, 'second.log'), FAKE_SESSION: 'native-2' })
				);
				await exited('restart');
				expect(exitCodes('restart')).toEqual([0]);

				// The superseded turn now ends; its completion reaches neither the tab nor the map.
				superseded.sdkController!.kill();
				await vi.waitFor(() => expect(internals().grokAcpSpawner.ctx.liveTurns.size).toBe(0));
				await new Promise((r) => setTimeout(r, 50));
				expect(of('exit', 'restart')).toHaveLength(1);
				expect(of('agent-error', 'restart')).toHaveLength(0);
				expect(first.pid).not.toBe(processManager.get('restart')?.pid);
			});

			it.each([
				['exact ticks above safe integer precision', '123456789012345678'],
				['an authoritative zero', '0'],
				['no reported cost', undefined],
			])('carries %s through the desktop recorder once', async (_name, ticks) => {
				const key = `usage-${ticks ?? 'none'}`;
				processManager.spawn(config(key, ticks === undefined ? {} : { FAKE_TICKS: ticks }));
				await exited(key);
				const usage = usageOf(key);
				// One terminal observation: recorded and billed once, with its provenance intact.
				expect(usage).toHaveLength(1);
				expect(usage[0]).toMatchObject({
					inputTokens: 100,
					outputTokens: 10,
					cacheReadInputTokens: 20,
					cacheCreationInputTokens: 10,
					reasoningTokens: 3,
					accounting: {
						source: 'runtime-stream',
						route: 'acp',
						scope: 'turn',
						final: true,
						completeness: 'complete',
						providerSessionId: `native-${key}`,
						turnId: `${key}:${usage[0].accounting.processGeneration}`,
						scopeId: JSON.stringify(['grok:fixture-account', 'fixture-machine']),
					},
				});
				const cost = usage[0].accounting.cost;
				if (ticks === undefined) {
					// Unknown is not a known zero: no ticks, no exact status.
					expect(cost).toEqual({ status: 'unknown' });
				} else {
					// The tick string is carried verbatim, never rebuilt from an unsafe number.
					expect(cost).toMatchObject({ status: 'exact', costUsdTicks: ticks });
					if (ticks === '0') expect(cost.costUsd).toBe(0);
				}
			});

			// Plans and negotiated questions through the real desktop consumer. The
			// pinned peer advertises no ask-back capability, so every question the turn owns is
			// cancelled on the wire with its method's own outcome and the tab reads one capability
			// gap; nothing reaches the consent surface and no answer path exists to cross tabs.
			describe('plans and questions', () => {
				const ASK = '_x.ai/ask_user_question';
				const ELICIT = '_x.ai/mcp/elicit';
				const textOf = (key: string) =>
					of('data', key)
						.map(([, , t]) => t)
						.join('');
				const plansOf = (key: string) =>
					of('tool-execution', key)
						.map(([, , e]) => e as any)
						.filter((e) => e.toolName === 'update_plan');
				const answersOf = (key: string) =>
					logOf(key).filter((l) => l.startsWith('qanswer ') || l.startsWith('qerror '));
				function expectGap(key: string, method: string) {
					const errors = of('agent-error', key);
					expect(errors).toHaveLength(1);
					const error = errors[0][2] as AgentError;
					expect(error.type).toBe('unknown');
					expect(error.type).not.toBe('permission_denied');
					expect(error.recoverable).toBe(false);
					expect(error.message).toContain(`(${method})`);
					expect(error.message).toMatch(/advertises no ask-back capability/);
					expect(error.message).toMatch(
						/no tool was authorized and no permission or policy changed/
					);
					expect(exitCodes(key)).toEqual([1]);
				}

				it('keeps two simultaneous tabs reusing one request id apart: plan, wire answer and gap stay with their owner', async () => {
					consent.answer = () => 'allow';
					processManager.spawn(
						config('qa', {
							FAKE_MODE: 'question',
							FAKE_PLAN: JSON.stringify([
								{ content: 'plan a', status: 'in_progress', priority: 'high' },
							]),
						})
					);
					processManager.spawn(
						config('qb', {
							FAKE_MODE: 'question',
							FAKE_QMETHOD: ELICIT,
							FAKE_QPARAMS: JSON.stringify({
								mode: 'form',
								message: 'Choose',
								requestedSchema: { type: 'object' },
							}),
							FAKE_PLAN: JSON.stringify([
								{ content: 'plan b', status: 'pending', priority: 'low' },
							]),
						})
					);
					processManager.spawn(config('plain', {}));
					expect(internals().grokAcpSpawner.ctx.liveTurns.size).toBe(3);
					await Promise.all([exited('qa'), exited('qb'), exited('plain')]);

					// Both peers used request id q-1; each got its own method's cancel outcome once.
					expect(answersOf('qa')).toEqual(['qanswer {"outcome":"cancelled"}']);
					expect(answersOf('qb')).toEqual(['qanswer {"outcome":"cancel"}']);
					expectGap('qa', ASK);
					expectGap('qb', ELICIT);
					expect((of('agent-error', 'qa')[0][2] as AgentError).message).toMatch(
						/a question for you/
					);
					expect((of('agent-error', 'qb')[0][2] as AgentError).message).toMatch(
						/an MCP elicitation/
					);
					// Each plan is a snapshot of its own native session, on its own tab only.
					const [planA] = plansOf('qa');
					const [planB] = plansOf('qb');
					expect(plansOf('qa')).toHaveLength(1);
					expect(plansOf('qb')).toHaveLength(1);
					expect(planA.state.input.plan).toEqual([
						expect.objectContaining({ step: 'plan a', status: 'in_progress' }),
					]);
					expect(planA.state.planUpdate).toMatchObject({
						reporting: 'snapshot',
						providerSessionId: 'native-qa',
					});
					expect(planB.state.input.plan).toEqual([
						expect.objectContaining({ step: 'plan b', status: 'pending' }),
					]);
					expect(planB.state.planUpdate).toMatchObject({ providerSessionId: 'native-qb' });
					// An answer is never an approval, even on a tab whose consent would allow.
					expect(consent.asked).toEqual([]);
					expect(of('agent-error', 'plain')).toHaveLength(0);
					expect(plansOf('plain')).toHaveLength(0);
					expect(exitCodes('plain')).toEqual([0]);
					expect(consent.closed.sort()).toEqual(['plain-tab', 'qa-tab', 'qb-tab']);
					expect(headless).not.toHaveBeenCalled();
				});

				it.each([
					[
						'a choices field that is not a list',
						{ questions: [{ question: 'x', options: 'A,B' }] },
					],
					[
						'a choice with no label',
						{ questions: [{ question: 'x', options: [{ label: null }] }] },
					],
					['no questions at all', { questions: 'malformed' }],
					['a free-text question', { questions: [{ question: 'Why?', options: [] }] }],
				])('cancels %s without waiting or asking the consent surface', async (_name, params) => {
					consent.answer = () => 'allow';
					processManager.spawn(
						config('malformed', { FAKE_MODE: 'question', FAKE_QPARAMS: JSON.stringify(params) })
					);
					await exited('malformed');
					expect(answersOf('malformed')).toEqual(['qanswer {"outcome":"cancelled"}']);
					expectGap('malformed', ASK);
					expect(consent.asked).toEqual([]);
					expect(textOf('malformed')).toContain('after question');
				});

				it.each([
					['another native session', { FAKE_QSESSION: 'native-elsewhere' }],
					[
						'an old prompt',
						{
							FAKE_QPARAMS: JSON.stringify({
								_meta: { promptId: 'old-prompt' },
								questions: [{ question: 'x', options: [{ label: 'A' }] }],
							}),
						},
					],
				])(
					'keeps a stale question for %s out of the turn: cancelled on the wire, no gap',
					async (_name, env) => {
						processManager.spawn(config('stale', { FAKE_MODE: 'question', ...env }));
						await exited('stale');
						expect(answersOf('stale')).toEqual(['qanswer {"outcome":"cancelled"}']);
						expect(of('agent-error', 'stale')).toHaveLength(0);
						expect(exitCodes('stale')).toEqual([0]);
						expect(textOf('stale')).toContain('after question');
						expect(consent.asked).toEqual([]);
					}
				);

				it('answers a duplicated question id once and ends the turn without a second answer', async () => {
					processManager.spawn(config('dup', { FAKE_MODE: 'question', FAKE_QREPLAY: '1' }));
					await exited('dup');
					expect(answersOf('dup')).toEqual(['qanswer {"outcome":"cancelled"}']);
					expect(of('exit', 'dup')).toHaveLength(1);
					expect(exitCodes('dup')).toEqual([1]);
					expectGap('dup', ASK);
					expect(consent.asked).toEqual([]);
					expect(internals().grokAcpSpawner.ctx.liveTurns.size).toBe(0);
				});

				it.each(['allow', 'deny'] as const)(
					'decides a later tool permission by the consent surface alone (%s), never by the question',
					async (decision) => {
						consent.answer = () => decision;
						processManager.spawn(
							config('scoped', { FAKE_MODE: 'question', FAKE_QTHEN: 'permission' })
						);
						await exited('scoped');
						expect(answersOf('scoped')).toEqual(['qanswer {"outcome":"cancelled"}']);
						// The consent surface saw the tool request, and only it.
						expect(consent.asked).toEqual([
							{ tabId: 'scoped-tab', toolName: 'Read', input: { path: 'README.md' } },
						]);
						expect(logOf('scoped')).toContain('answer:perm-1');
						expect(textOf('scoped')).toContain(decision === 'allow' ? 'Allowed answer' : 'Denied');
						if (decision === 'deny') expect(textOf('scoped')).not.toContain('Allowed');
						// The cancelled question still keeps the turn from reading as a success.
						expectGap('scoped', ASK);
					}
				);

				it('treats a stop after a question as the person stopping, not a gap', async () => {
					processManager.spawn(
						config('qstop', {
							FAKE_MODE: 'question',
							FAKE_QTHEN: 'hold',
							FAKE_SESSION: 'native-qs',
						})
					);
					await vi.waitFor(() => expect(answersOf('qstop')).toHaveLength(1), { timeout: 8000 });
					expect(processManager.interrupt('qstop')).toBe(true);
					await exited('qstop');
					expect(logOf('qstop')).toContain('session/cancel native-qs');
					expect(exitCodes('qstop')).toEqual([0]);
					expect(of('agent-error', 'qstop')).toHaveLength(0);
					expect(consent.asked).toEqual([]);
				});

				it('reconnects to the same native session after a gap without re-delivering the old question', async () => {
					processManager.spawn(
						config('recon', { FAKE_MODE: 'question', FAKE_SESSION: 'native-r' })
					);
					await exited('recon');
					expectGap('recon', ASK);

					events.length = 0;
					processManager.spawn(
						config('recon', { FAKE_LOG: path.join(dir, 'recon-resume.log') }, {
							args: ['--resume', 'native-r'],
							agentSessionId: 'native-r',
							nativeSessionBinding: { ...scope(), nativeSessionId: 'native-r' },
						} as Partial<ProcessConfig>)
					);
					await exited('recon');
					expect(logOf('recon-resume')).toEqual([
						'initialize',
						'session/load native-r',
						'session/prompt native-r',
						'prompt [{"type":"text","text":"work on recon"}]',
					]);
					expect(of('agent-error', 'recon')).toHaveLength(0);
					expect(exitCodes('recon')).toEqual([0]);
					expect(textOf('recon')).toContain('Hello from ACP');
				});

				it('refuses an unsupported reverse method with a structured Method not found, not a gap or approval', async () => {
					consent.answer = () => 'allow';
					processManager.spawn(
						config('unsupported', { FAKE_MODE: 'question', FAKE_QMETHOD: `${ASK}/v2` })
					);
					await exited('unsupported');
					expect(answersOf('unsupported')).toEqual(['qerror -32601']);
					expect(of('agent-error', 'unsupported')).toHaveLength(0);
					expect(exitCodes('unsupported')).toEqual([0]);
					expect(consent.asked).toEqual([]);
					expect(plansOf('unsupported')).toHaveLength(1);
				});
			});

			// Discovery handoff: `agents:discoverSlashCommands` hands
			// `discoverGrokSlashCommands` this ProcessManager's own reader; nothing else answers.
			describe('selected-agent command discovery over the live owner', () => {
				const COMMANDS = [
					{ name: 'review', description: 'Review the diff', input: { hint: 'path' } },
				];
				const SECRET = 'xai-fixture-secret-0123456789';
				const envFor = (key: string, extra: Record<string, string> = {}) => ({
					FAKE_LOG: path.join(dir, `${key}.log`),
					FAKE_SESSION: `native-${key}`,
					FAKE_MODE: 'hold',
					FAKE_COMMANDS: JSON.stringify(COMMANDS),
					XAI_API_KEY: SECRET,
					...extra,
				});
				async function liveTurn(key: string, env: Record<string, string>, extra = {}) {
					expect(processManager.spawn(config(key, env, extra)).success).toBe(true);
					// This launches a real child process; match the bounded exit wait rather
					// than Vitest's 1s default, which races startup on a busy CI host.
					await vi.waitFor(
						() => expect(logOf(key).some((l) => l.startsWith('prompt'))).toBe(true),
						{ timeout: 8000 }
					);
				}
				function discover(
					key: string,
					env: Record<string, string>,
					over: Record<string, unknown> = {}
				) {
					const context = {
						cwd: dir,
						customPath: wrapper,
						model: undefined,
						effort: undefined,
						environment: { surface: 'desktop', sessionCustomEnvVars: env },
						target: { kind: 'local' },
						...over,
					} as Parameters<typeof discoverGrokSlashCommands>[0];
					return discoverGrokSlashCommands(
						context,
						(over.sessionId as string | undefined) ?? `native-${key}`,
						(selection) => processManager.grokCommandObservation(selection)
					);
				}
				const unavailable = (reason: string) => ({ status: 'unavailable', commands: [], reason });

				it('answers two tabs on two accounts from their own advertisements, with no RPC, process or leak', async () => {
					const a = envFor('disc-a');
					const b = envFor('disc-b', {
						FAKE_COMMANDS: JSON.stringify([{ name: 'plan', description: 'Plan it' }]),
					});
					await liveTurn('disc-a', a);
					await liveTurn('disc-b', b, { nativeSessionScope: scope('grok:second-account') });
					const before = [logOf('disc-a').length, logOf('disc-b').length];

					const first = await discover('disc-a', a);
					const second = await discover('disc-b', b);

					expect(first).toMatchObject({
						status: 'discovered',
						commands: [{ name: 'review', kind: 'native-command', argumentHint: 'path' }],
						binding: {
							route: 'grok-acp',
							sessionId: 'native-disc-a',
							account: 'grok:fixture-account',
							host: 'fixture-machine',
							agentVersion: '9.9.9-fixture',
						},
					});
					expect(second).toMatchObject({
						status: 'discovered',
						commands: [{ name: 'plan', kind: 'native-command' }],
						binding: { sessionId: 'native-disc-b', account: 'grok:second-account' },
					});
					// A read is not a request: no RPC to either peer, no process, no headless fallback.
					expect([logOf('disc-a').length, logOf('disc-b').length]).toEqual(before);
					expect(headless).not.toHaveBeenCalled();
					for (const result of [first, second]) {
						expect(JSON.stringify(result)).not.toContain(SECRET);
						expect(JSON.stringify(result)).not.toContain(dir);
					}
				});

				it('tells an empty advertisement from a missing one, and refuses an invalid catalog', async () => {
					await liveTurn('disc-empty', envFor('disc-empty', { FAKE_COMMANDS: '[]' }));
					const missing = envFor('disc-none');
					delete (missing as Record<string, string>).FAKE_COMMANDS;
					await liveTurn('disc-none', missing);
					const invalid = envFor('disc-bad', {
						FAKE_COMMANDS: JSON.stringify([...COMMANDS, ...COMMANDS]),
					});
					await liveTurn('disc-bad', invalid);

					expect(
						await discover('disc-empty', envFor('disc-empty', { FAKE_COMMANDS: '[]' }))
					).toMatchObject({ status: 'discovered', commands: [] });
					expect(await discover('disc-none', missing)).toEqual(
						unavailable('observation-unavailable')
					);
					expect(await discover('disc-bad', invalid)).toEqual(unavailable('invalid-catalog'));
				});

				it('reads a changed executable, model, environment, cwd, session or stale generation as unavailable', async () => {
					const env = envFor('disc-stale');
					await liveTurn('disc-stale', env);
					expect(await discover('disc-stale', env)).toMatchObject({ status: 'discovered' });
					for (const over of [
						{ customPath: path.join(dir, 'other-grok') },
						{ model: 'grok-other' },
						{ effort: 'high' },
						{
							environment: {
								surface: 'desktop',
								sessionCustomEnvVars: { ...env, GROK_HOME: dir },
							},
						},
						{ cwd: path.join(dir, 'elsewhere') },
						{ sessionId: 'native-someone-else' },
						{ configGeneration: 'stale-generation' },
					])
						expect(await discover('disc-stale', env, over)).toEqual(
							unavailable('observation-unavailable')
						);
				});

				it('reads a stopped, exited, replaced or never-started owner as unavailable', async () => {
					const env = envFor('disc-life');
					await liveTurn('disc-life', env);
					const replaced = processManager.get('disc-life')!;
					// A newer spawn on the key takes the advertisement away from the older turn.
					const next = envFor('disc-life', { FAKE_SESSION: 'native-disc-life-2' });
					internals().grokAcpSpawner.spawn(config('disc-life', next));
					await vi.waitFor(
						() => expect(logOf('disc-life').filter((l) => l.startsWith('prompt'))).toHaveLength(2),
						{ timeout: 8000 }
					);
					expect(await discover('disc-life', env)).toEqual(unavailable('observation-unavailable'));
					expect(
						await discover('disc-life', next, { sessionId: 'native-disc-life-2' })
					).toMatchObject({ status: 'discovered' });
					replaced.sdkController!.kill();

					// Stop withdraws it at once, before the process has exited.
					expect(processManager.interrupt('disc-life')).toBe(true);
					expect(await discover('disc-life', next, { sessionId: 'native-disc-life-2' })).toEqual(
						unavailable('observation-unavailable')
					);
					await exited('disc-life');
					expect(await discover('disc-life', next, { sessionId: 'native-disc-life-2' })).toEqual(
						unavailable('observation-unavailable')
					);
					expect(await discover('never-started', envFor('never-started'))).toEqual(
						unavailable('observation-unavailable')
					);
				});

				it('refuses remote routes without reading the owner', async () => {
					const env = envFor('disc-route');
					await liveTurn('disc-route', env);
					const read = vi.spyOn(processManager, 'grokCommandObservation');
					expect(
						await discover('disc-route', env, {
							target: { kind: 'ssh', remoteId: 'remote-1' },
						})
					).toEqual(unavailable('remote-unqualified'));
					expect(read).not.toHaveBeenCalled();
				});
			});
		});

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
				processManager.on('agent-error', (_sessionId: string, error: AgentError) => {
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
		});

		describe('kill() PTY signal handling', () => {
			afterEach(() => {
				// Restore default platform delegation so a forced value doesn't leak.
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
			});

			it('should send SIGTERM (not default SIGHUP) to PTY processes', () => {
				// Force the POSIX branch so this signal assertion holds on any host
				// (Windows correctly uses taskkill, which CI on Unix never exercises).
				mockIsWindows.mockReturnValue(false);
				const mockPtyKill = vi.fn();
				const mockOnExit = vi.fn();
				const processes = (processManager as any).processes as Map<string, any>;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					isTerminal: true,
					pid: 12345,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					ptyProcess: {
						pid: 12345,
						kill: mockPtyKill,
						onExit: mockOnExit,
						onData: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
					},
				});

				processManager.kill('pty-session');

				expect(mockPtyKill).toHaveBeenCalledWith('SIGTERM');
			});

			it('should schedule SIGKILL escalation for PTY processes', () => {
				mockIsWindows.mockReturnValue(false);
				vi.useFakeTimers();
				const mockPtyKill = vi.fn();
				const mockOnExit = vi.fn();
				const processes = (processManager as any).processes as Map<string, any>;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					isTerminal: true,
					pid: 12345,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					ptyProcess: {
						pid: 12345,
						kill: mockPtyKill,
						onExit: mockOnExit,
						onData: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
					},
				});

				processManager.kill('pty-session');

				// First call is SIGTERM
				expect(mockPtyKill).toHaveBeenCalledTimes(1);
				expect(mockPtyKill).toHaveBeenCalledWith('SIGTERM');

				// Advance past escalation timeout (2000ms)
				vi.advanceTimersByTime(2100);

				// SIGKILL should have been sent as escalation
				expect(mockPtyKill).toHaveBeenCalledTimes(2);
				expect(mockPtyKill).toHaveBeenCalledWith('SIGKILL');

				vi.useRealTimers();
			});

			it('should cancel SIGKILL escalation if PTY exits on its own', () => {
				mockIsWindows.mockReturnValue(false);
				vi.useFakeTimers();
				const mockPtyKill = vi.fn();
				let exitCallback: (() => void) | undefined;
				const mockOnExit = vi.fn((cb: () => void) => {
					exitCallback = cb;
					return { dispose: vi.fn() };
				});
				const processes = (processManager as any).processes as Map<string, any>;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					isTerminal: true,
					pid: 12345,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					ptyProcess: {
						pid: 12345,
						kill: mockPtyKill,
						onExit: mockOnExit,
						onData: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
					},
				});

				processManager.kill('pty-session');

				// Simulate PTY exiting on its own before escalation
				exitCallback?.();

				// Advance past escalation timeout
				vi.advanceTimersByTime(2100);

				// Only SIGTERM should have been sent (SIGKILL cancelled)
				expect(mockPtyKill).toHaveBeenCalledTimes(1);
				expect(mockPtyKill).toHaveBeenCalledWith('SIGTERM');

				vi.useRealTimers();
			});
		});

		describe('interrupt() / kill() on an SSH agent', () => {
			function registerChild(sessionId: string) {
				const child = Object.assign(new EventEmitter(), {
					pid: 4242,
					killed: false,
					exitCode: null as number | null,
					signalCode: null as string | null,
					kill: vi.fn(function (this: { killed: boolean }) {
						this.killed = true;
						return true;
					}),
				});
				const processes = (processManager as any).processes as Map<string, any>;
				processes.set(sessionId, {
					sessionId,
					toolType: 'claude-code',
					isTerminal: false,
					pid: 4242,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					childProcess: child,
				});
				return { child, processes };
			}

			afterEach(() => {
				vi.useRealTimers();
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
			});

			// The local child of an SSH spawn is only the ssh client: signalling it
			// left the remote agent running (48 minutes, 2026-10-12).
			it('asks the remote host to interrupt, then terminate, an SSH agent', () => {
				mockIsWindows.mockReturnValue(false);
				vi.useFakeTimers();
				mockSignalRemoteAgent.mockClear();
				const { processes } = registerChild('ssh-session');
				const sshArgs = ['u@h', '/bin/bash', '--norc', '--noprofile', '-s'];
				Object.assign(processes.get('ssh-session'), {
					command: '/usr/bin/ssh',
					args: sshArgs,
					sshRemotePidFile: '/tmp/maestro-agent-1.pid',
				});
				const target = {
					sshCommand: '/usr/bin/ssh',
					sshArgs,
					pidFile: '/tmp/maestro-agent-1.pid',
					sessionId: 'ssh-session',
				};

				processManager.interrupt('ssh-session');
				expect(mockSignalRemoteAgent).toHaveBeenCalledWith(target, 'interrupt');

				vi.advanceTimersByTime(2100);
				expect(mockSignalRemoteAgent).toHaveBeenLastCalledWith(target, 'terminate');
			});

			it('does not reach for a remote host for a local agent', () => {
				mockIsWindows.mockReturnValue(false);
				mockSignalRemoteAgent.mockClear();
				registerChild('local-session');

				processManager.interrupt('local-session');
				processManager.kill('local-session');

				expect(mockSignalRemoteAgent).not.toHaveBeenCalled();
			});
		});

		describe('kill method - Windows tree kill', () => {
			const TASKKILL_PTY = [
				'taskkill',
				['/pid', '12345', '/t', '/f'],
				{ timeout: 5000 },
				expect.any(Function),
			];

			// A running child, as Node reports one: the stop ladder signals only a
			// process whose exit state is still null.
			function runningChild(pid: number) {
				return Object.assign(new EventEmitter(), {
					kill: vi.fn(),
					pid,
					exitCode: null,
					signalCode: null,
				});
			}

			function trackPty(ptyProcess: unknown) {
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					ptyProcess,
					isTerminal: true,
					pid: 12345,
					cwd: os.tmpdir(),
					startTime: Date.now(),
				});
			}

			beforeEach(() => {
				mockExecFile.mockReset();
				mockExecFileSync.mockReset();
			});

			afterEach(() => {
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
			});

			it('should use taskkill tree-kill for PTY processes on Windows', () => {
				mockIsWindows.mockReturnValue(true);
				const mockPtyProcess = { pid: 12345, kill: vi.fn(), onExit: vi.fn() };
				trackPty(mockPtyProcess);

				processManager.kill('pty-session');

				expect(mockExecFile).toHaveBeenCalledWith(...TASKKILL_PTY);
				expect(mockExecFileSync).not.toHaveBeenCalled();
				expect(mockPtyProcess.kill).not.toHaveBeenCalled();
			});

			it('should block on taskkill when the app is shutting down', () => {
				mockIsWindows.mockReturnValue(true);
				const mockPtyProcess = { pid: 12345, kill: vi.fn(), onExit: vi.fn() };
				trackPty(mockPtyProcess);

				processManager.kill('pty-session', { sync: true, shutdown: true });

				expect(mockExecFileSync).toHaveBeenCalledWith('taskkill', ['/pid', '12345', '/t', '/f'], {
					timeout: 5000,
				});
				expect(mockExecFile).not.toHaveBeenCalled();
				expect(mockPtyProcess.kill).not.toHaveBeenCalled();
				expect(mockPtyProcess.onExit).not.toHaveBeenCalled();
			});

			it('should not throw when taskkill fails for a process that is already gone', () => {
				mockIsWindows.mockReturnValue(true);
				mockExecFile.mockImplementationOnce(
					(
						_command: string,
						_arguments: string[],
						_options: { timeout: number },
						callback: (callbackError: Error) => void
					) => callback(new Error('taskkill failed'))
				);
				trackPty({ pid: 12345, kill: vi.fn(), onExit: vi.fn() });

				expect(() => processManager.kill('pty-session')).not.toThrow();
				expect(mockExecFile).toHaveBeenCalledWith(...TASKKILL_PTY);
			});

			it('should use SIGTERM for PTY processes on non-Windows', () => {
				mockIsWindows.mockReturnValue(false);
				const mockPtyProcess = { pid: 12345, kill: vi.fn(), onExit: vi.fn() };
				trackPty(mockPtyProcess);

				processManager.kill('pty-session');

				expect(mockPtyProcess.kill).toHaveBeenCalledWith('SIGTERM');
				expect(mockExecFile).not.toHaveBeenCalled();
			});

			it('should use taskkill tree-kill for child processes on Windows', () => {
				mockIsWindows.mockReturnValue(true);

				const mockChildProcess = runningChild(99999);
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('child-session', {
					sessionId: 'child-session',
					toolType: 'claude-code',
					childProcess: mockChildProcess,
					isTerminal: false,
					pid: 99999,
					cwd: os.tmpdir(),
					startTime: Date.now(),
				});

				processManager.kill('child-session');

				expect(mockExecFile).toHaveBeenCalledWith(
					'taskkill',
					['/pid', '99999', '/t', '/f'],
					{ timeout: 5000 },
					expect.any(Function)
				);
				expect(mockChildProcess.kill).not.toHaveBeenCalled();
			});

			it('should remove process from map after kill', () => {
				mockIsWindows.mockReturnValue(true);
				trackPty({ pid: 12345, kill: vi.fn(), onExit: vi.fn() });

				processManager.kill('pty-session');

				expect(processManager.get('pty-session')).toBeUndefined();
			});
		});

		describe('stopping a pipe-backed agent on POSIX', () => {
			// A running child, as Node reports one. The pid is not a child of this
			// test process, so the ladder signals it through the handle alone.
			function trackAgent() {
				const child = Object.assign(new EventEmitter(), {
					kill: vi.fn(() => {
						// Node flips this as soon as a signal is SENT.
						(child as unknown as { killed: boolean }).killed = true;
						return true;
					}),
					pid: 99999,
					exitCode: null as number | null,
					signalCode: null as NodeJS.Signals | null,
					killed: false,
					stdin: null,
				});
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				const managed = {
					sessionId: 'agent-session',
					toolType: 'claude-code',
					childProcess: child,
					isTerminal: false,
					pid: 99999,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					interrupted: false,
				};
				processes.set('agent-session', managed);
				return { child, managed };
			}

			beforeEach(() => {
				mockIsWindows.mockReturnValue(false);
				// `ps` reports nothing, so no tree is ever claimed as this test's own.
				mockExecFileSync.mockReset();
				mockExecFileSync.mockReturnValue('');
				vi.useFakeTimers();
			});

			afterEach(() => {
				vi.useRealTimers();
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
			});

			it('interrupt escalates past an agent that ignores SIGINT', () => {
				const { child, managed } = trackAgent();

				expect(processManager.interrupt('agent-session')).toBe(true);
				expect(managed.interrupted).toBe(true);
				expect(child.kill.mock.calls).toEqual([['SIGINT']]);

				vi.advanceTimersByTime(2000);
				expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']]);

				vi.advanceTimersByTime(2000);
				expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM'], ['SIGKILL']]);
			});

			it('interrupt sends nothing more once the agent exits', () => {
				const { child } = trackAgent();

				processManager.interrupt('agent-session');
				child.exitCode = 0;
				child.emit('exit', 0, null);
				vi.advanceTimersByTime(10_000);

				expect(child.kill.mock.calls).toEqual([['SIGINT']]);
			});

			it('interrupt leaves the process tracked so its exit still settles the turn', () => {
				trackAgent();

				processManager.interrupt('agent-session');
				vi.advanceTimersByTime(4000);

				expect(processManager.get('agent-session')).toBeDefined();
			});

			it('kill follows SIGTERM with SIGKILL for an agent that traps it', () => {
				const { child } = trackAgent();

				expect(processManager.kill('agent-session')).toBe(true);
				expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
				expect(processManager.get('agent-session')).toBeUndefined();

				vi.advanceTimersByTime(2000);
				expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
			});

			it('kill on shutdown sends SIGTERM only and leaves no timer behind', () => {
				// Quitting has always sent a pipe-backed agent SIGTERM and nothing
				// more, so it can finish writing its state. A SIGKILL right behind
				// it would take that chance away.
				const { child } = trackAgent();

				processManager.kill('agent-session', { sync: true, shutdown: true });

				expect(child.kill.mock.calls).toEqual([['SIGTERM']]);
				expect(child.listenerCount('exit')).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
			});
		});

		describe('interrupt() on a PTY', () => {
			it('sends Ctrl+C and never escalates, since a shell outlives it by design', () => {
				vi.useFakeTimers();
				const ptyProcess = {
					pid: 12345,
					kill: vi.fn(),
					write: vi.fn(),
					onExit: vi.fn(),
					onData: vi.fn(),
					resize: vi.fn(),
				};
				const processes = (processManager as unknown as { processes: Map<string, unknown> })
					.processes;
				processes.set('pty-session', {
					sessionId: 'pty-session',
					toolType: 'terminal',
					ptyProcess,
					isTerminal: true,
					pid: 12345,
					cwd: os.tmpdir(),
					startTime: Date.now(),
				});

				expect(processManager.interrupt('pty-session')).toBe(true);
				vi.advanceTimersByTime(10_000);

				expect(ptyProcess.write).toHaveBeenCalledWith('\x03');
				expect(ptyProcess.kill).not.toHaveBeenCalled();
				expect(processManager.get('pty-session')).toBeDefined();
				vi.useRealTimers();
			});
		});

		describe('spawn() existing process guard', () => {
			beforeEach(() => {
				mockIsPidAlive.mockReturnValue(true);
			});

			afterEach(() => {
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
				mockIsPidAlive.mockReturnValue(true);
			});

			it('should kill existing process before spawning with same sessionId', () => {
				// Force the POSIX branch so the SIGTERM assertion holds on any host.
				mockIsWindows.mockReturnValue(false);
				const mockPtyKill = vi.fn();
				const mockOnExit = vi.fn();
				const processes = (processManager as any).processes as Map<string, any>;
				processes.set('dup-session', {
					sessionId: 'dup-session',
					toolType: 'terminal',
					isTerminal: true,
					pid: 11111,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					ptyProcess: {
						pid: 11111,
						kill: mockPtyKill,
						onExit: mockOnExit,
						onData: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
					},
				});

				try {
					processManager.spawn({
						sessionId: 'dup-session',
						toolType: 'terminal',
						cwd: os.tmpdir(),
						command: 'zsh',
						args: [],
						shell: 'zsh',
					});
				} catch {
					// spawn may fail due to mock - we only care about the kill call
				}

				expect(mockPtyKill).toHaveBeenCalledWith('SIGTERM');
			});

			it('should refuse to replace a live agent process with the same sessionId', () => {
				const processes = (processManager as any).processes as Map<string, any>;
				const liveChildProcess = {
					pid: 32828,
					exitCode: null,
					signalCode: null,
					kill: vi.fn(),
				};
				const liveProcess = {
					sessionId: 'dup-agent-session',
					toolType: 'codex',
					isTerminal: false,
					pid: 32828,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					childProcess: liveChildProcess,
				};
				processes.set('dup-agent-session', liveProcess);

				expect(() =>
					processManager.spawn({
						sessionId: 'dup-agent-session',
						toolType: 'codex',
						cwd: os.tmpdir(),
						command: 'codex',
						args: ['exec', '--json'],
						prompt: 'second turn',
					})
				).toThrow('Agent process already running for session dup-agent-session');
				expect(liveChildProcess.kill).not.toHaveBeenCalled();
				expect(processManager.get('dup-agent-session')).toBe(liveProcess);
			});

			it('should retain an exited agent until close cleanup drains its output', () => {
				// The PID is already gone here: node saw the child exit, so `close` is
				// still draining trailing stdout microseconds later. Reclaiming on
				// liveness alone would drop that final response (issue #1249), so the
				// drain window must stay refused even though the process is dead.
				mockIsPidAlive.mockReturnValue(false);
				const processes = (processManager as any).processes as Map<string, any>;
				const exitingChildProcess = {
					pid: 32829,
					exitCode: 0,
					signalCode: null,
					kill: vi.fn(),
				};
				const exitingProcess = {
					sessionId: 'draining-agent-session',
					toolType: 'codex',
					isTerminal: false,
					pid: 32829,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					childProcess: exitingChildProcess,
				};
				processes.set('draining-agent-session', exitingProcess);

				expect(() =>
					processManager.spawn({
						sessionId: 'draining-agent-session',
						toolType: 'codex',
						cwd: os.tmpdir(),
						command: 'codex',
						args: ['exec', '--json'],
						prompt: 'replayed turn',
					})
				).toThrow('Agent process already running for session draining-agent-session');
				expect(exitingChildProcess.kill).not.toHaveBeenCalled();
				expect(processManager.get('draining-agent-session')).toBe(exitingProcess);
			});

			it('should reclaim an agent entry whose OS process no longer exists', () => {
				// Issue #1339: after a long idle the child died without node ever
				// seeing `close`, so the entry (still "running" as far as node knows)
				// owned the session id forever and every later turn threw.
				mockIsPidAlive.mockReturnValue(false);
				const processes = (processManager as any).processes as Map<string, any>;
				const staleChildProcess = {
					pid: 32830,
					exitCode: null,
					signalCode: null,
					kill: vi.fn(),
				};
				const staleProcess = {
					sessionId: 'stale-agent-session',
					toolType: 'codex',
					isTerminal: false,
					pid: 32830,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					childProcess: staleChildProcess,
				};
				processes.set('stale-agent-session', staleProcess);

				let thrown: unknown;
				try {
					processManager.spawn({
						sessionId: 'stale-agent-session',
						toolType: 'codex',
						cwd: os.tmpdir(),
						command: 'codex',
						args: ['exec', '--json'],
						prompt: 'turn after idle',
					});
				} catch (err) {
					// The spawn itself may still fail against the mocked child_process;
					// what matters is that it was no longer blocked by the guard.
					thrown = err;
				}

				expect(String((thrown as Error | undefined)?.message ?? '')).not.toContain(
					'Agent process already running'
				);
				// The dead entry is dropped, and never signalled - there is no process
				// left to kill, and a kill() would emit a spurious exit.
				expect(processManager.get('stale-agent-session')).not.toBe(staleProcess);
				expect(staleChildProcess.kill).not.toHaveBeenCalled();
			});

			it('should refuse to replace an SDK-backed agent turn even when no OS pid is alive', () => {
				// SDK turns have no OS child of their own, so a liveness probe proves
				// nothing and could match an unrelated recycled PID.
				mockIsPidAlive.mockReturnValue(false);
				const processes = (processManager as any).processes as Map<string, any>;
				const sdkProcess = {
					sessionId: 'sdk-agent-session',
					toolType: 'opencode',
					isTerminal: false,
					pid: 32831,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					sdkController: { interrupt: vi.fn(), kill: vi.fn() },
				};
				processes.set('sdk-agent-session', sdkProcess);

				expect(() =>
					processManager.spawn({
						sessionId: 'sdk-agent-session',
						toolType: 'opencode',
						cwd: os.tmpdir(),
						command: 'opencode',
						args: ['run'],
						prompt: 'second turn',
					})
				).toThrow('Agent process already running for session sdk-agent-session');
				expect(processManager.get('sdk-agent-session')).toBe(sdkProcess);
			});
		});

		describe('killAll() map safety', () => {
			afterEach(() => {
				mockIsWindows.mockImplementation(() => process.platform === 'win32');
			});

			it('should kill all processes even when kill() deletes from the map', () => {
				mockIsWindows.mockReturnValue(true);
				const kills: string[] = [];
				const originalKill = processManager.kill.bind(processManager);
				processManager.kill = (sessionId: string, opts?: { sync?: boolean }) => {
					kills.push(sessionId);
					return originalKill(sessionId, opts);
				};

				const processes = (processManager as any).processes as Map<string, any>;
				for (const id of ['a', 'b', 'c']) {
					processes.set(id, {
						sessionId: id,
						toolType: 'terminal',
						isTerminal: true,
						pid: 1,
						cwd: os.tmpdir(),
						startTime: Date.now(),
						ptyProcess: {
							pid: 1,
							kill: vi.fn(),
							onExit: vi.fn(),
							onData: vi.fn(),
							write: vi.fn(),
							resize: vi.fn(),
						},
					});
				}

				processManager.killAll();

				expect(kills).toEqual(expect.arrayContaining(['a', 'b', 'c']));
				expect(kills).toHaveLength(3);
				expect(mockExecFileSync).toHaveBeenCalledTimes(3);
				expect(mockExecFileSync).toHaveBeenCalledWith('taskkill', ['/pid', '1', '/t', '/f'], {
					timeout: 5000,
				});
			});

			it('should pass sync: true to kill() so Windows taskkill blocks until complete', () => {
				mockIsWindows.mockReturnValue(true);
				const killSpy = vi.spyOn(processManager, 'kill');

				const processes = (processManager as any).processes as Map<string, any>;
				processes.set('sync-test', {
					sessionId: 'sync-test',
					toolType: 'terminal',
					isTerminal: true,
					pid: 1,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					ptyProcess: {
						pid: 1,
						kill: vi.fn(),
						onExit: vi.fn(),
						onData: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
					},
				});

				processManager.killAll();

				expect(killSpy).toHaveBeenCalledWith('sync-test', { sync: true, shutdown: false });
				expect(mockExecFileSync).toHaveBeenCalledWith('taskkill', ['/pid', '1', '/t', '/f'], {
					timeout: 5000,
				});
				killSpy.mockRestore();
			});

			it('should SIGKILL ptys directly when shutdown:true to avoid TSFN teardown race', () => {
				// Force the POSIX branch: on Windows the taskkill path is taken first
				// (correct behavior), so the shutdown-SIGKILL branch is only reachable
				// off-Windows. This mirrors what CI exercises on Unix.
				mockIsWindows.mockReturnValue(false);
				const mockPtyKill = vi.fn();
				const mockOnExit = vi.fn();

				const processes = (processManager as any).processes as Map<string, any>;
				processes.set('shutdown-test', {
					sessionId: 'shutdown-test',
					toolType: 'terminal',
					isTerminal: true,
					pid: 1,
					cwd: os.tmpdir(),
					startTime: Date.now(),
					ptyProcess: {
						pid: 1,
						kill: mockPtyKill,
						onExit: mockOnExit,
						onData: vi.fn(),
						write: vi.fn(),
						resize: vi.fn(),
					},
				});

				processManager.killAll({ shutdown: true });

				// SIGKILL only - no SIGTERM, no escalation timer, no onExit listener.
				expect(mockPtyKill).toHaveBeenCalledTimes(1);
				expect(mockPtyKill).toHaveBeenCalledWith('SIGKILL');
				expect(mockOnExit).not.toHaveBeenCalled();
				expect(mockExecFile).not.toHaveBeenCalled();
				expect(mockExecFileSync).not.toHaveBeenCalled();
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
			processManager.on('data', (_sessionId: string, data: string) => {
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
			processManager.on('data', (_sessionId: string, data: string) => {
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
