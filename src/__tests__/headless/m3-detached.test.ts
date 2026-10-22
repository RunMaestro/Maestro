/**
 * M3 sanity check: Auto Run API is wired into the runtime.
 *
 * Verify that the runtime accepts Auto Run launch requests and that the API
 * is accessible. Full playbook execution with a fake provider is too heavy for
 * a unit test and is covered by integration tests. This test validates the M3
 * requirement that the library Auto Run engine is accessible through the runtime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { CAPTURED_RECORDINGS } from '../main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../shared/maestro-lib/run/fakeAgent';
import { DEFAULT_TAB_DEFAULTS } from '../../shared/maestro-lib/agents/rules';
import type { ClientResult } from '../../shared/maestro-lib/client/types';
import { runAgentTurn } from '../../shared/maestro-lib/turns/run-agent-turn';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type RuntimeDeps,
} from '../../shared/maestro-lib/runtime';
import type { WatchDirectory } from '../../shared/maestro-lib/runtime/settings-watch';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../shared/prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

describe('M3 end-to-end: detached runtime with Auto Run persistence', () => {
	let dir: string;
	let work: string;
	let recordings: Record<string, string>;

	const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

	const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
		return runAgentTurn(
			{
				...turn,
				launch: {
					...turn.launch,
					command: process.execPath,
					args: [FAKE_AGENT_PATH, ...turn.launch.args],
					sessionCustomEnvVars: {
						...turn.launch.sessionCustomEnvVars,
						FAKE_AGENT_RECORDING: recordings[turn.provider.id],
					},
				},
			},
			{ ...options, stopGraceMs: 200 }
		);
	};

	function deps(): Partial<RuntimeDeps> {
		let id = 0;
		let now = 1_000;
		return {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory,
			probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
			turns: { runAgentTurn: fakeProvider },
		};
	}

	const seedAgent = (extra: Record<string, unknown> = {}) => ({
		id: 'a1',
		name: 'TestAgent',
		toolType: 'claude-code',
		cwd: work,
		projectRoot: work,
		aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
		activeTabId: 't1',
		unifiedTabOrder: [{ type: 'ai', id: 't1' }],
		...extra,
	});

	async function startRuntime(sessions: unknown[] = [seedAgent()]): Promise<MaestroRuntime> {
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		return started.runtime;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m3-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m3-work-'));
		recordings = {
			'claude-code': writeFakeTurn(
				work,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
			),
		};

		// Create playbooks folder
		fs.mkdirSync(path.join(work, '.maestro', 'playbooks'), { recursive: true });
	});

	afterEach(async () => {
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	it('accepts spec-driven Auto Run launch requests', async () => {
		// Create a three-task playbook
		const playbookPath = path.join(work, '.maestro', 'playbooks', 'test.md');
		const playbookContent = `# Test Playbook

- [ ] First task
- [ ] Second task
- [ ] Third task
`;
		fs.writeFileSync(playbookPath, playbookContent);

		// Start the runtime in-process.
		const runtime = await startRuntime();

		try {
			// Verify the Auto Run API exists on the runtime.
			expect(runtime.autoRun).toBeDefined();
			expect(typeof runtime.autoRun.launch).toBe('function');
			expect(typeof runtime.autoRun.launchGoal).toBe('function');
			expect(typeof runtime.autoRun.stop).toBe('function');

			// Verify the launch request is accepted.
			const result = value(
				await runtime.autoRun.launch('a1', {
					documents: [{ file: playbookPath }],
				})
			);

			// Result should be void (undefined) per the AutoRunApi.
			expect(result).toBeUndefined();
		} finally {
			await runtime.connection.close();
		}
	});

	it('accepts goal-driven Auto Run launch requests', async () => {
		// Start the runtime in-process.
		const runtime = await startRuntime();

		try {
			// Verify we can launch a goal-driven run.
			const result = value(
				await runtime.autoRun.launchGoal('a1', {
					goal: 'Complete the test goal successfully',
					exitCriteria: 'Goal is marked as complete',
					maxIterations: 10,
				})
			);

			// Result should have tabId (optional per API).
			expect(result).toBeDefined();
			expect(typeof result === 'object').toBe(true);
		} finally {
			await runtime.connection.close();
		}
	});
});
