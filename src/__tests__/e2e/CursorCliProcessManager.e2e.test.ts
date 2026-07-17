/**
 * E2E smoke test for cursor-cli through ProcessManager (desktop spawn path).
 * Run: RUN_INTEGRATION_TESTS=true npx vitest run --config vitest.e2e.config.ts CursorCliProcessManager
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { promisify } from 'util';
import { exec } from 'child_process';
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

const execAsync = promisify(exec);
const SKIP_E2E = process.env.RUN_INTEGRATION_TESTS !== 'true';
const TIMEOUT = 120_000;

function buildBatchArgs(prompt: string): string[] {
	const agent = getAgentDefinition('cursor-cli');
	if (!agent) throw new Error('cursor-cli agent definition missing');

	return buildAgentArgs(agent as unknown as AgentConfig, {
		baseArgs: [...(agent.args || [])],
		prompt,
		cwd: process.cwd(),
		yoloMode: true,
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
	try {
		await execAsync(process.platform === 'win32' ? 'where agent' : 'which agent');
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(SKIP_E2E)('CursorCliProcessManager E2E', () => {
	let agentAvailable = false;
	let pm: ProcessManager;

	beforeAll(async () => {
		agentAvailable = await isAgentAvailable();
	});

	afterEach(() => {
		pm?.removeAllListeners();
	});

	it(
		'runs one headless turn through ProcessManager and parses stream-json',
		async () => {
			if (!agentAvailable) return;

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
});
