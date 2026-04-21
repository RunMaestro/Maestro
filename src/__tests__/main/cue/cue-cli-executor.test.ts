/**
 * Tests for cue-cli-executor.
 *
 * Verifies that subscriptions with `action: command` + `command.mode: 'cli'`
 * shell out to `node maestro-cli.js send <target> <message> --live`, with
 * template substitution applied to both target and (optional) message.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { CueEvent, CueSubscription } from '../../../main/cue/cue-types';
import type { SessionInfo } from '../../../shared/types';
import type { TemplateContext } from '../../../shared/templateVariables';

class MockChildProcess extends EventEmitter {
	pid = 54321;
	exitCode: number | null = null;
	signalCode: string | null = null;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killed = false;

	kill(_signal?: string) {
		this.killed = true;
		return true;
	}

	constructor() {
		super();
		(this.stdout as any).setEncoding = vi.fn();
		(this.stderr as any).setEncoding = vi.fn();
	}
}

let mockChild: MockChildProcess;
const mockSpawn = vi.fn((..._args: unknown[]) => {
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

const mockCaptureException = vi.fn();
vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

import { executeCueCli, stopCueCliRun } from '../../../main/cue/cue-cli-executor';

function createSession(): SessionInfo {
	return {
		id: 'session-1',
		name: 'Test Session',
		toolType: 'claude-code',
		cwd: '/projects/test',
		projectRoot: '/projects/test',
	};
}

function createEvent(payloadOverrides: Record<string, unknown> = {}): CueEvent {
	return {
		id: 'evt-1',
		type: 'agent.completed',
		timestamp: '2026-04-16T10:00:00.000Z',
		triggerName: 'cli-test',
		payload: {
			sourceSession: 'researcher',
			sourceSessionId: 'session-research',
			sourceOutput: 'computed answer = 42',
			...payloadOverrides,
		},
	};
}

function createSubscription(): CueSubscription {
	return {
		name: 'cli-test',
		event: 'agent.completed',
		enabled: true,
		prompt: '{{CUE_FROM_AGENT}}',
		action: 'command',
		command: { mode: 'cli', cli: { command: 'send', target: '{{CUE_FROM_AGENT}}' } },
	};
}

function createConfig(overrides: Record<string, unknown> = {}) {
	const templateContext: TemplateContext = {
		session: {
			id: 'session-1',
			name: 'Test Session',
			toolType: 'claude-code',
			cwd: '/projects/test',
			projectRoot: '/projects/test',
		},
	};
	return {
		runId: 'run-1',
		session: createSession(),
		subscription: createSubscription(),
		event: createEvent(),
		cli: { command: 'send' as const, target: '{{CUE_FROM_AGENT}}' },
		templateContext,
		timeoutMs: 30000,
		onLog: vi.fn(),
		...overrides,
	};
}

describe('cue-cli-executor', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('substitutes {{CUE_FROM_AGENT}} in target before invoking maestro-cli send', async () => {
		const config = createConfig();
		const promise = executeCueCli(config as any);
		// Let the microtask scheduler register the close handler before we emit.
		await Promise.resolve();
		mockChild.emit('close', 0);
		const result = await promise;

		expect(mockSpawn).toHaveBeenCalledTimes(1);
		const args = mockSpawn.mock.calls[0][1] as string[];
		expect(args[0]).toContain('maestro-cli.js');
		expect(args[1]).toBe('send');
		expect(args[2]).toBe('session-research'); // CUE_FROM_AGENT resolved from sourceSessionId
		expect(args[3]).toBe('computed answer = 42');
		expect(args[4]).toBe('--live');
		expect(result.status).toBe('completed');
	});

	it('caps argv message length to stay under the platform spawn limit', async () => {
		// Windows `CreateProcessW` has a 32K command-line ceiling; on POSIX
		// `ARG_MAX` is much higher. Either way, the message passed as argv
		// must be truncated to CLI_SEND_OUTPUT_MAX_CHARS before spawn so the
		// call doesn't fail with ENAMETOOLONG on Windows. A warn-level log
		// is emitted whenever truncation kicks in.
		const onLog = vi.fn();
		const longMessage = 'x'.repeat(200_000);
		const config = createConfig({
			cli: {
				command: 'send' as const,
				target: 'session-A',
				message: longMessage,
			},
			onLog,
		});
		const promise = executeCueCli(config as any);
		await Promise.resolve();
		mockChild.emit('close', 0);
		await promise;

		const args = mockSpawn.mock.calls[0][1] as string[];
		const sentMessage = args[3];
		// Should not exceed either platform cap (POSIX: 100K, Windows: 30K).
		expect(sentMessage.length).toBeLessThanOrEqual(100_000);
		expect(sentMessage.length).toBeGreaterThan(0);
		// Truncation warning surfaced to the user.
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringMatching(/truncated/i));
	});

	it('spawns with ELECTRON_RUN_AS_NODE=1 so packaged Electron runs Node, not the app', async () => {
		// In packaged Electron, `process.execPath` is the app binary. Without
		// this env flag the spawn would relaunch the app instead of running
		// maestro-cli.js, silently breaking Cue output delivery in production.
		const config = createConfig();
		const promise = executeCueCli(config as any);
		await Promise.resolve();
		mockChild.emit('close', 0);
		await promise;

		const spawnOptions = mockSpawn.mock.calls[0][2] as { env?: Record<string, string> };
		expect(spawnOptions.env?.ELECTRON_RUN_AS_NODE).toBe('1');
	});

	it('uses an explicit message override when provided', async () => {
		const config = createConfig({
			cli: {
				command: 'send' as const,
				target: 'session-A',
				message: 'Hello from {{CUE_TRIGGER_NAME}}: {{CUE_SOURCE_OUTPUT}}',
			},
		});
		const promise = executeCueCli(config as any);
		await Promise.resolve();
		mockChild.emit('close', 0);
		await promise;

		const args = mockSpawn.mock.calls[0][1] as string[];
		expect(args[2]).toBe('session-A');
		expect(args[3]).toBe('Hello from cli-test: computed answer = 42');
	});

	it('reports failed status when target resolves to empty string', async () => {
		const config = createConfig({
			event: createEvent({ sourceSessionId: '', sourceAgentId: '' }),
			cli: { command: 'send' as const, target: '{{CUE_FROM_AGENT}}' },
		});
		const result = await executeCueCli(config as any);

		expect(mockSpawn).not.toHaveBeenCalled();
		expect(result.status).toBe('failed');
		expect(result.stderr).toMatch(/empty string/i);
	});

	it('reports failed status when maestro-cli exits non-zero', async () => {
		const config = createConfig({
			cli: { command: 'send' as const, target: 'literal-session-id' },
		});
		const promise = executeCueCli(config as any);
		await Promise.resolve();
		mockChild.stderr.emit('data', 'session not found');
		mockChild.emit('close', 2);
		const result = await promise;

		expect(result.status).toBe('failed');
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('session not found');
	});

	it('reports failed with null exitCode on spawn-failure string codes (e.g. ENOENT)', async () => {
		const config = createConfig({
			cli: { command: 'send' as const, target: 'x' },
		});
		const promise = executeCueCli(config as any);
		await Promise.resolve();
		const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
		mockChild.emit('error', err);
		const result = await promise;

		expect(result.status).toBe('failed');
		expect(result.exitCode).toBeNull();
		// ENOENT is an expected failure mode (missing CLI bundle) — must NOT
		// be captured to Sentry, otherwise dev-only misconfig spams prod error
		// tracking.
		expect(mockCaptureException).not.toHaveBeenCalled();
	});

	it('reports unexpected child error to Sentry (non-ENOENT)', async () => {
		const config = createConfig({
			cli: { command: 'send' as const, target: 'x' },
		});
		const promise = executeCueCli(config as any);
		await Promise.resolve();
		const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
		mockChild.emit('error', err);
		await promise;

		expect(mockCaptureException).toHaveBeenCalledWith(
			err,
			expect.objectContaining({ operation: 'cue:cli:childProcess:error' })
		);
	});

	it('reports failed status and captures exception when spawn throws synchronously', async () => {
		mockSpawn.mockImplementationOnce(() => {
			throw new Error('boom');
		});
		const config = createConfig({
			cli: { command: 'send' as const, target: 'x' },
		});
		const result = await executeCueCli(config as any);

		expect(result.status).toBe('failed');
		expect(result.stderr).toContain('boom');
		// Unexpected sync spawn failure must reach Sentry so it isn't lost.
		expect(mockCaptureException).toHaveBeenCalledWith(
			expect.any(Error),
			expect.objectContaining({ operation: 'cue:cli:spawn' })
		);
	});

	it('stopCueCliRun signals an active CLI process and returns true', async () => {
		const config = createConfig();
		const promise = executeCueCli(config as any);
		await Promise.resolve();

		const stopped = stopCueCliRun('run-1');
		expect(stopped).toBe(true);
		expect(mockChild.killed).toBe(true);

		mockChild.emit('close', null);
		await promise;
	});

	it('stopCueCliRun returns false for unknown runId', () => {
		expect(stopCueCliRun('does-not-exist')).toBe(false);
	});
});
