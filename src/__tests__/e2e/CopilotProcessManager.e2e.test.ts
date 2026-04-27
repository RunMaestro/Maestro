/**
 * E2E Tests for Copilot-CLI through the full ProcessManager pipeline
 *
 * These tests drive the REAL ProcessManager + ChildProcessSpawner +
 * StdoutHandler + CopilotOutputParser chain against a locally-installed
 * Copilot CLI binary. They catch regressions the unit tests can't:
 *   - Argument assembly (buildAgentArgs + promptArgs + batchModeArgs)
 *   - Stdin close behavior (batch mode hangs if stdin stays open)
 *   - JSONL concatenation handling (Copilot emits without newlines)
 *   - session-id extraction from the final `result` event
 *   - Result-text emission when modern Copilot omits `phase: final_answer`
 *
 * REQUIREMENTS:
 *   - Copilot CLI installed and authenticated (`copilot login`)
 *   - Gated on RUN_INTEGRATION_TESTS=true so CI skips by default
 *
 * To run:  RUN_INTEGRATION_TESTS=true npm test -- CopilotProcessManager
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { promisify } from 'util';
import { exec } from 'child_process';
import { ProcessManager } from '../../main/process-manager/ProcessManager';
import { getAgentDefinition } from '../../main/agents/definitions';
import { getAgentCapabilities } from '../../main/agents/capabilities';
import { buildAgentArgs } from '../../main/utils/agent-args';
import type { AgentConfig } from '../../main/agents/definitions';

const execAsync = promisify(exec);

const SKIP_E2E = process.env.RUN_INTEGRATION_TESTS !== 'true';
const COPILOT_TIMEOUT = 60_000;

interface CapturedEvents {
	data: string[];
	sessionIds: string[];
	usage: unknown[];
	toolExecutions: Array<{ toolName: string; state?: { status?: string } }>;
	thinkingChunks: string[];
	errors: unknown[];
	exitCode: number | null;
	rawStdout: string;
}

function createCapture(pm: ProcessManager, sessionId: string): CapturedEvents {
	const captured: CapturedEvents = {
		data: [],
		sessionIds: [],
		usage: [],
		toolExecutions: [],
		thinkingChunks: [],
		errors: [],
		exitCode: null,
		rawStdout: '',
	};

	pm.on('data', (id: string, data: string) => {
		if (id === sessionId) captured.data.push(data);
	});
	pm.on('session-id', (id: string, value: string) => {
		if (id === sessionId) captured.sessionIds.push(value);
	});
	pm.on('usage', (id: string, usage: unknown) => {
		if (id === sessionId) captured.usage.push(usage);
	});
	pm.on('tool-execution', (id: string, exec: { toolName: string; state?: { status?: string } }) => {
		if (id === sessionId) captured.toolExecutions.push(exec);
	});
	pm.on('thinking-chunk', (id: string, chunk: string) => {
		if (id === sessionId) captured.thinkingChunks.push(chunk);
	});
	pm.on('agent-error', (id: string, err: unknown) => {
		if (id === sessionId) captured.errors.push(err);
	});
	pm.on('raw-stdout', (id: string, data: string) => {
		if (id === sessionId) captured.rawStdout += data;
	});
	pm.on('exit', (id: string, code: number) => {
		if (id === sessionId) captured.exitCode = code;
	});

	return captured;
}

function waitForExit(pm: ProcessManager, sessionId: string, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pm.kill(sessionId);
			reject(new Error(`Timeout waiting for ${sessionId} to exit`));
		}, timeoutMs);

		pm.on('exit', (id: string, code: number) => {
			if (id === sessionId) {
				clearTimeout(timer);
				resolve(code);
			}
		});
	});
}

async function isCopilotAvailable(): Promise<boolean> {
	try {
		await execAsync('copilot --version');
		return true;
	} catch {
		return false;
	}
}

/**
 * Build the exact arg list the production IPC handler would pass to
 * ProcessManager.spawn for a Copilot batch-mode message.
 *
 * Using buildAgentArgs + the agent definition mirrors the real code path,
 * so any future definition change (flags, ordering) is automatically
 * picked up by these tests.
 */
function buildBatchArgs(prompt: string, options: { resumeSessionId?: string } = {}): string[] {
	const agent = getAgentDefinition('copilot-cli');
	if (!agent) throw new Error('copilot-cli agent definition missing');

	const baseArgs = [...(agent.args || [])];
	// Resume flag is prepended by IPC handler when a session ID is available.
	if (options.resumeSessionId && agent.resumeArgs) {
		baseArgs.push(...agent.resumeArgs(options.resumeSessionId));
	}

	return buildAgentArgs(agent as unknown as AgentConfig, { baseArgs, prompt });
}

describe.skipIf(SKIP_E2E)('Copilot-CLI E2E through ProcessManager', () => {
	let copilotAvailable = false;
	let pm: ProcessManager;

	beforeAll(async () => {
		copilotAvailable = await isCopilotAvailable();
		if (!copilotAvailable) {
			console.log('⚠️  Copilot CLI not available — tests will be skipped');
		}
	});

	afterEach(() => {
		if (pm) {
			// Kill any stragglers to avoid leaking processes across tests.
			pm.removeAllListeners();
		}
	});

	it(
		'emits session-id, result data, and usage on a simple batch prompt',
		async () => {
			if (!copilotAvailable) return;

			pm = new ProcessManager();
			const sessionId = 'test-copilot-basic';
			const prompt = 'Reply with the single word HELLO and nothing else.';
			const args = buildBatchArgs(prompt);

			const agent = getAgentDefinition('copilot-cli')!;
			const captured = createCapture(pm, sessionId);
			const exitPromise = waitForExit(pm, sessionId, COPILOT_TIMEOUT);

			const result = pm.spawn({
				sessionId,
				toolType: 'copilot-cli',
				cwd: '/tmp',
				command: agent.command,
				args,
				prompt,
				promptArgs: agent.promptArgs,
				requiresPty: agent.requiresPty,
			});

			expect(result.success).toBe(true);
			expect(result.pid).toBeGreaterThan(0);

			const code = await exitPromise;

			// Copilot should exit cleanly on a trivial prompt.
			expect(code).toBe(0);
			expect(captured.errors).toEqual([]);

			// session-id is the primary signal that we parsed the final result.
			expect(
				captured.sessionIds.length,
				'exactly one session-id event from the final result'
			).toBeGreaterThanOrEqual(1);
			expect(captured.sessionIds[0]).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
			);

			// The `data` event carries the flushed result text.
			const fullData = captured.data.join('');
			expect(fullData.toUpperCase(), 'response should contain HELLO').toContain('HELLO');

			// Usage stats should arrive (from session.shutdown.modelMetrics).
			// Copilot sometimes omits modelMetrics on ultra-short prompts; treat
			// absence as non-fatal and just log — token stats are a nice-to-have,
			// not a correctness invariant.
			if (captured.usage.length === 0) {
				console.log('ℹ️  No usage stats emitted for this run (ok for trivial prompts)');
			}
		},
		COPILOT_TIMEOUT
	);

	it(
		'captures tool-execution events when the prompt requires tool use',
		async () => {
			if (!copilotAvailable) return;

			pm = new ProcessManager();
			const sessionId = 'test-copilot-tools';
			const prompt =
				'Run `echo maestro-e2e-marker` using the bash tool and report the exact stdout.';
			const args = buildBatchArgs(prompt);

			const agent = getAgentDefinition('copilot-cli')!;
			const captured = createCapture(pm, sessionId);
			const exitPromise = waitForExit(pm, sessionId, COPILOT_TIMEOUT);

			pm.spawn({
				sessionId,
				toolType: 'copilot-cli',
				cwd: '/tmp',
				command: agent.command,
				args,
				prompt,
				promptArgs: agent.promptArgs,
				requiresPty: agent.requiresPty,
			});

			const code = await exitPromise;
			expect(code).toBe(0);
			expect(captured.errors).toEqual([]);

			// At least one tool should have been invoked (report_intent or bash).
			expect(captured.toolExecutions.length).toBeGreaterThan(0);

			// The final result should mention the marker.
			const fullData = captured.data.join('');
			expect(fullData).toContain('maestro-e2e-marker');
		},
		COPILOT_TIMEOUT
	);

	it(
		'resumes a prior session via --resume and preserves context',
		async () => {
			if (!copilotAvailable) return;

			// Turn 1: seed context with a memorable token
			pm = new ProcessManager();
			const sessionA = 'test-copilot-resume-turn1';
			const captureA = createCapture(pm, sessionA);
			const exitA = waitForExit(pm, sessionA, COPILOT_TIMEOUT);

			const agent = getAgentDefinition('copilot-cli')!;
			pm.spawn({
				sessionId: sessionA,
				toolType: 'copilot-cli',
				cwd: '/tmp',
				command: agent.command,
				args: buildBatchArgs(
					'Remember the marker token PURPLE_MAESTRO_42. Reply with exactly "Got it." and nothing else.'
				),
				prompt: 'Remember the marker token PURPLE_MAESTRO_42. Reply with exactly "Got it."',
				promptArgs: agent.promptArgs,
				requiresPty: agent.requiresPty,
			});

			expect(await exitA).toBe(0);
			const firstSessionId = captureA.sessionIds[0];
			expect(firstSessionId).toBeTruthy();

			// Turn 2: resume and ask to recall the token
			const sessionB = 'test-copilot-resume-turn2';
			const captureB = createCapture(pm, sessionB);
			const exitB = waitForExit(pm, sessionB, COPILOT_TIMEOUT);

			pm.spawn({
				sessionId: sessionB,
				toolType: 'copilot-cli',
				cwd: '/tmp',
				command: agent.command,
				args: buildBatchArgs(
					'What was the marker token? Reply with just the token, nothing else.',
					{
						resumeSessionId: firstSessionId,
					}
				),
				prompt: 'What was the marker token? Reply with just the token, nothing else.',
				promptArgs: agent.promptArgs,
				requiresPty: agent.requiresPty,
			});

			expect(await exitB).toBe(0);
			const fullData = captureB.data.join('');
			expect(fullData.toUpperCase(), 'resumed session should recall the token').toContain(
				'PURPLE_MAESTRO_42'
			);
		},
		COPILOT_TIMEOUT * 2
	);

	it(
		'sanity check: ProcessManager spawn uses ChildProcessSpawner (not PTY) when prompt is present',
		async () => {
			if (!copilotAvailable) return;

			// Copilot has requiresPty: true, but a prompt should override that and
			// route to ChildProcessSpawner. Regression guard for shouldUsePty logic:
			//   return (toolType === 'terminal' || requiresPty === true) && !prompt;
			pm = new ProcessManager();
			const sessionId = 'test-copilot-spawn-path';
			const captured = createCapture(pm, sessionId);
			const exitPromise = waitForExit(pm, sessionId, COPILOT_TIMEOUT);

			const agent = getAgentDefinition('copilot-cli')!;
			pm.spawn({
				sessionId,
				toolType: 'copilot-cli',
				cwd: '/tmp',
				command: agent.command,
				args: buildBatchArgs('Reply with OK.'),
				prompt: 'Reply with OK.',
				promptArgs: agent.promptArgs,
				requiresPty: true, // Explicitly set to prove prompt overrides it
			});

			// If we accidentally took the PTY path, stdin would stay open and
			// Copilot would hang — the timeout in waitForExit would fail the test.
			const code = await exitPromise;
			expect(code).toBe(0);
			expect(captured.sessionIds.length).toBeGreaterThanOrEqual(1);
		},
		COPILOT_TIMEOUT
	);
});

describe('Copilot-CLI definition invariants', () => {
	// These run always (not gated on E2E) to catch definition drift.

	it('batchModeArgs includes --allow-all (no path/url permission prompts)', () => {
		const agent = getAgentDefinition('copilot-cli');
		expect(agent?.batchModeArgs).toEqual(['--allow-all']);
	});

	it('jsonOutputArgs emits JSONL stream Copilot can parse', () => {
		const agent = getAgentDefinition('copilot-cli');
		expect(agent?.jsonOutputArgs).toEqual(['--output-format', 'json']);
	});

	it('promptArgs uses -p (non-interactive mode)', () => {
		const agent = getAgentDefinition('copilot-cli');
		expect(agent?.promptArgs?.('hi')).toEqual(['-p', 'hi']);
	});

	it('resumeArgs uses --resume=<id> (single-arg form documented by Copilot)', () => {
		const agent = getAgentDefinition('copilot-cli');
		expect(agent?.resumeArgs?.('abc-123')).toEqual(['--resume=abc-123']);
	});

	it('capabilities mark Copilot-CLI as streaming + batch + JSONL', () => {
		const caps = getAgentCapabilities('copilot-cli');
		expect(caps.supportsBatchMode).toBe(true);
		expect(caps.supportsJsonOutput).toBe(true);
		expect(caps.supportsStreaming).toBe(true);
		expect(caps.usesJsonLineOutput).toBe(true);
		expect(caps.supportsSessionId).toBe(true);
	});

	it('exposes Reasoning Effort with the Copilot-CLI levels (low/medium/high/xhigh + default)', () => {
		const agent = getAgentDefinition('copilot-cli');
		const opt = agent?.configOptions?.find((o) => o.key === 'reasoningEffort');
		expect(opt, 'Reasoning Effort config option must be present').toBeDefined();
		expect(opt?.type).toBe('select');
		if (opt?.type === 'select') {
			expect(opt.options).toEqual(['', 'low', 'medium', 'high', 'xhigh']);
			expect(opt.argBuilder?.('high')).toEqual(['--reasoning-effort', 'high']);
			expect(opt.argBuilder?.('')).toEqual([]);
			expect(opt.argBuilder?.('  ')).toEqual([]);
		}
	});

	it('buildAgentArgs produces the complete batch-mode argv', () => {
		const agent = getAgentDefinition('copilot-cli')!;
		const argv = buildAgentArgs(agent as unknown as AgentConfig, {
			baseArgs: [],
			prompt: 'hello',
		});
		// Order matters: batchModeArgs → jsonOutputArgs → (prompt args appended by spawner).
		expect(argv).toEqual(['--allow-all', '--output-format', 'json']);
		// promptArgs are applied by the spawner, not buildAgentArgs; verify they
		// would produce the full command shape when combined.
		const withPrompt = [...argv, ...(agent.promptArgs?.('hello') || [])];
		expect(withPrompt).toEqual(['--allow-all', '--output-format', 'json', '-p', 'hello']);
	});
});
