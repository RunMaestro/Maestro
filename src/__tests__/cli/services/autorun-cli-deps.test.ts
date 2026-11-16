/**
 * Tests for the CLI Auto Run turn wiring: every turn a CLI Auto Run spawns
 * runs on the agent's own settings, including its own custom binary.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(async () => ({ success: true, response: 'ok', agentSessionId: 's-1' })),
}));
vi.mock('../../../cli/services/agent-run-capture', () => ({
	captureCliRun: vi.fn((_capture: unknown, run: () => Promise<unknown>) => run()),
	settlementFromAgentResult: vi.fn(),
}));
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn(async () => 'SYSTEM'),
}));
vi.mock('../../../cli/services/storage', () => ({
	addHistoryEntry: vi.fn(),
	readGroups: vi.fn(() => []),
	readHistory: vi.fn(() => []),
	readSettings: vi.fn(() => ({})),
}));

import { createCliAutoRunDeps } from '../../../cli/services/autorun-cli-deps';
import { spawnAgent } from '../../../cli/services/agent-spawner';
import type { SessionInfo } from '../../../shared/types';
import type { AutoRunTurnRequest } from '../../../shared/maestro-lib/autorun/engine-types';

const session = {
	id: 'agent-1',
	name: 'Agent',
	toolType: 'claude-code',
	cwd: '/project',
	projectRoot: '/project',
	customPath: '/agent/bin/claude',
	customArgs: '--flag',
} as unknown as SessionInfo;

describe('createCliAutoRunDeps', () => {
	beforeEach(() => {
		vi.mocked(spawnAgent).mockClear();
	});

	it.each(['task', 'synopsis', 'goal-iteration', 'goal-handoff'] as const)(
		"runs a %s turn on the agent's own custom binary",
		async (purpose) => {
			const deps = createCliAutoRunDeps(session);
			await deps.turns.prepare?.();
			await deps.turns.run({
				purpose,
				prompt: 'do it',
				resumeSessionId: purpose === 'synopsis' ? 'prev' : undefined,
			} as AutoRunTurnRequest);

			expect(spawnAgent).toHaveBeenCalledOnce();
			expect(vi.mocked(spawnAgent).mock.calls[0][4]).toMatchObject({
				sessionCustomPath: '/agent/bin/claude',
				customArgs: '--flag',
			});
		}
	);
});
