/**
 * E2E smoke test for cursor-cli through the CLI spawner path.
 * Run: RUN_INTEGRATION_TESTS=true npx vitest run --config vitest.e2e.config.ts CursorCliSpawner
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { promisify } from 'util';
import { exec } from 'child_process';
import { detectAgent, spawnAgent } from '../../cli/services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { buildAgentArgs } from '../../main/utils/agent-args';
import type { AgentConfig } from '../../main/agents/definitions';

const execAsync = promisify(exec);
const SKIP_E2E = process.env.RUN_INTEGRATION_TESTS !== 'true';
const TIMEOUT = 120_000;

async function isAgentAvailable(): Promise<boolean> {
	try {
		await execAsync(process.platform === 'win32' ? 'where agent' : 'which agent');
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(SKIP_E2E)('CursorCliSpawner E2E', () => {
	let agentAvailable = false;

	beforeAll(async () => {
		agentAvailable = await isAgentAvailable();
	});

	it('detects agent on PATH', async () => {
		if (!agentAvailable) return;
		const detected = await detectAgent('cursor-cli');
		expect(detected.available).toBe(true);
		expect(detected.path).toBeTruthy();
	});

	it('builds expected batch args', () => {
		const agent = getAgentDefinition('cursor-cli');
		expect(agent).toBeTruthy();
		const args = buildAgentArgs(agent as unknown as AgentConfig, {
			baseArgs: [...(agent!.args || [])],
			prompt: 'hello',
			cwd: process.cwd(),
			yoloMode: true,
		});
		expect(args).toContain('--trust');
		expect(args).toContain('--output-format');
		expect(args).toContain('stream-json');
		expect(args).toContain('--force');
	});

	it(
		'spawns a real headless turn and parses the response',
		async () => {
			if (!agentAvailable) return;

			const result = await spawnAgent(
				'cursor-cli',
				process.cwd(),
				'Reply with exactly: E2E_OK',
				undefined,
				{ customModel: 'auto' }
			);

			expect(result.success).toBe(true);
			expect(result.response).toContain('E2E_OK');
			expect(result.agentSessionId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
			);
		},
		TIMEOUT
	);
});
