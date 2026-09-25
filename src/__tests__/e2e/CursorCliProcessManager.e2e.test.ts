/**
 * E2E smoke test for cursor-cli through ProcessManager (desktop spawn path).
 * Run: RUN_INTEGRATION_TESTS=true bunx vitest run --config vitest.e2e.config.ts CursorCliProcessManager
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: {
		getPath: (name: string) => {
			if (name === 'userData') {
				return path.join(os.tmpdir(), 'maestro-cursor-cli-e2e');
			}
			return os.tmpdir();
		},
	},
}));

import { ProcessManager } from '../../main/process-manager/ProcessManager';
import { getAgentDefinition } from '../../main/agents/definitions';
import { buildAgentArgs } from '../../main/utils/agent-args';
import type { AgentConfig } from '../../main/agents/definitions';
import { detectAgent } from '../../cli/services/agent-spawner';
import { isWindows } from '../../shared/platformDetection';

const SKIP_E2E = process.env.RUN_INTEGRATION_TESTS !== 'true';
const TIMEOUT = 120_000;

function buildBatchArgs(
	prompt: string,
	options: { readOnlyMode?: boolean; yoloMode?: boolean } = { yoloMode: true }
): string[] {
	const agent = getAgentDefinition('cursor-cli');
	if (!agent) throw new Error('cursor-cli agent definition missing');

	return buildAgentArgs(agent as unknown as AgentConfig, {
		baseArgs: [...(agent.args || [])],
		prompt,
		cwd: process.cwd(),
		readOnlyMode: options.readOnlyMode,
		yoloMode: options.yoloMode,
	});
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

async function isAgentAvailable(): Promise<boolean> {
	return (await detectAgent('cursor-cli')).available;
}

describe.skipIf(SKIP_E2E)('CursorCliProcessManager E2E', () => {
	let agentAvailable = false;
	let pm: ProcessManager;

	beforeAll(async () => {
		agentAvailable = await isAgentAvailable();
		expect(agentAvailable).toBe(true);
	});

	afterEach(() => {
		pm?.removeAllListeners();
	});

	it(
		'runs one headless turn through ProcessManager and parses stream-json',
		async () => {
			pm = new ProcessManager();
			const sessionId = 'test-cursor-cli-basic';
			const prompt = 'Reply with exactly: E2E_OK';
			const args = buildBatchArgs(prompt);
			const agent = getAgentDefinition('cursor-cli')!;
			const detected = await detectAgent('cursor-cli');
			const command = detected.path ?? agent.command;

			expect(args).toContain('--trust');
			expect(args).toContain('--force');
			expect(args).toContain('stream-json');
			expect(args).toContain('--stream-partial-output');

			const chunks: string[] = [];
			const sessionIds: string[] = [];
			pm.on('data', (id, data) => {
				if (id === sessionId) chunks.push(data);
			});
			pm.on('session-id', (id, sid) => {
				if (id === sessionId) sessionIds.push(sid);
			});

			const spawnResult = pm.spawn({
				sessionId,
				toolType: 'cursor-cli',
				cwd: process.cwd(),
				command,
				args,
				prompt,
				promptArgs: agent.promptArgs,
				requiresPty: agent.requiresPty,
				yoloMode: true,
				runInShell: isWindows(),
			});

			expect(spawnResult.success).toBe(true);
			expect(spawnResult.pid).toBeGreaterThan(0);

			const exitCode = await waitForExit(pm, sessionId, TIMEOUT);
			expect(exitCode).toBe(0);

			const text = chunks.join('');
			expect(text).toContain('E2E_OK');
			expect(sessionIds.length).toBeGreaterThan(0);
		},
		TIMEOUT
	);

	it(
		'runs the Windows wizard raw-stdin path in trusted plan mode',
		async () => {
			pm = new ProcessManager();
			const sessionId = 'test-cursor-cli-raw-stdin';
			const prompt = 'Include this exact token in your response: MAESTRO_CURSOR_STDIN_OK';
			const args = buildBatchArgs(prompt, { readOnlyMode: true, yoloMode: false });
			const agent = getAgentDefinition('cursor-cli')!;
			const detected = await detectAgent('cursor-cli');
			const command = detected.path ?? agent.command;

			expect(args).toContain('-p');
			expect(args).toContain('--trust');
			expect(args).toContain('--mode');
			expect(args).toContain('plan');
			expect(args).not.toContain('--force');
			expect(args).not.toContain(prompt);

			const chunks: string[] = [];
			pm.on('data', (id, data) => {
				if (id === sessionId) chunks.push(data);
			});

			const spawnResult = pm.spawn({
				sessionId,
				toolType: 'cursor-cli',
				cwd: process.cwd(),
				command,
				args,
				prompt,
				promptArgs: agent.promptArgs,
				requiresPty: agent.requiresPty,
				readOnlyMode: true,
				sendPromptViaStdinRaw: true,
				runInShell: isWindows(),
			});

			expect(spawnResult.success).toBe(true);
			const exitCode = await waitForExit(pm, sessionId, TIMEOUT);
			expect(exitCode).toBe(0);
			expect(chunks.join('')).toContain('MAESTRO_CURSOR_STDIN_OK');
		},
		TIMEOUT
	);
});
