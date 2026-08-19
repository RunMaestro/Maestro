/**
 * E2E smoke test for cursor-cli through the CLI spawner path.
 * Run: RUN_INTEGRATION_TESTS=true bunx vitest run --config vitest.e2e.config.ts CursorCliSpawner
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { detectAgent, spawnAgent } from '../../cli/services/agent-spawner';
import { getAgentDefinition } from '../../main/agents/definitions';
import { buildAgentArgs } from '../../main/utils/agent-args';
import type { AgentConfig } from '../../main/agents/definitions';

const SKIP_E2E = process.env.RUN_INTEGRATION_TESTS !== 'true';
const TIMEOUT = 120_000;

async function isAgentAvailable(): Promise<boolean> {
	return (await detectAgent('cursor-cli')).available;
}

describe.skipIf(SKIP_E2E)('CursorCliSpawner E2E', () => {
	let agentAvailable = false;

	beforeAll(async () => {
		agentAvailable = await isAgentAvailable();
		expect(agentAvailable).toBe(true);
	});

	it('detects agent on PATH', async () => {
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
		expect(args).toContain('--stream-partial-output');
	});

	it(
		'spawns a real headless turn and parses the response',
		async () => {
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

	it(
		'resumes a real chat by session id',
		async () => {
			const first = await spawnAgent(
				'cursor-cli',
				process.cwd(),
				'Reply with exactly: CURSOR_RESUME_FIRST'
			);
			expect(first.success).toBe(true);
			expect(first.agentSessionId).toBeTruthy();

			const resumed = await spawnAgent(
				'cursor-cli',
				process.cwd(),
				'Reply with exactly: CURSOR_RESUME_OK',
				first.agentSessionId
			);
			expect(resumed.success).toBe(true);
			expect(resumed.response).toContain('CURSOR_RESUME_OK');
			expect(resumed.agentSessionId).toBe(first.agentSessionId);
		},
		TIMEOUT
	);
});
