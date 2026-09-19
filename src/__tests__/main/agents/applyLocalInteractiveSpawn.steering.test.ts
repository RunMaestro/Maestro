/**
 * @file applyLocalInteractiveSpawn.steering.test.ts
 * @description Covers the seam between the two halves of chat steering: the spawn
 * decision is the ONE place that knows a turn resolved to a local maestro-p, so it
 * is where the steering socket is named. If it stops naming one, steering goes
 * silently unavailable - the client would find nothing listening and correctly
 * report "not steerable" for every turn, with nothing anywhere saying why.
 */

import { describe, expect, it, vi } from 'vitest';

import { STEERING_SOCKET_ENV_VAR } from '../../../shared/chatSteering';
import { applyLocalInteractiveSpawnDecision } from '../../../main/ipc/handlers/process/apply-local-interactive-spawn';
import { steeringSocketPathFor } from '../../../main/process-manager/steering-client';
import type { ClaudeSpawnContext } from '../../../main/ipc/handlers/process/resolve-claude-spawn-context';
import type { SpawnProcessConfig } from '../../../main/ipc/handlers/process/spawn-types';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const PROCESS_KEY = 'agent-abc-ai-tab-1';

function config(overrides: Partial<SpawnProcessConfig> = {}): SpawnProcessConfig {
	return {
		sessionId: PROCESS_KEY,
		command: 'claude',
		cwd: '/tmp/project',
		toolType: 'claude-code',
		...overrides,
	} as SpawnProcessConfig;
}

function interactiveContext(overrides: Partial<ClaudeSpawnContext> = {}): ClaudeSpawnContext {
	return {
		claudeResolvedMode: 'interactive',
		claudeResolvedReason: 'auto',
		resolvedMaestroPBinPath: '/usr/local/bin/maestro-p',
		resolvedConfigDirKey: 'default',
		claudeDecisionRealBinPath: '/usr/local/bin/claude',
		claudeResolvedRemote: false,
		...overrides,
	} as ClaudeSpawnContext;
}

function run(cfg: SpawnProcessConfig, ctx: ClaudeSpawnContext) {
	return applyLocalInteractiveSpawnDecision({
		config: cfg,
		agent: null,
		claudeContext: ctx,
		commandToSpawn: 'claude',
		argsToSpawn: ['-p', 'hello'],
		customEnvVarsToPass: undefined,
	});
}

describe('applyLocalInteractiveSpawnDecision - steering channel', () => {
	it('names the steering socket for a local interactive turn', () => {
		const result = run(config(), interactiveContext());

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBe(
			steeringSocketPathFor(PROCESS_KEY)
		);
	});

	it('derives the path from the process key, so the client finds it without being told', () => {
		// The client runs later, from an IPC call holding only the key. Nothing carries
		// the path between them, which is the entire reason it is derived.
		const a = run(config({ sessionId: 'agent-abc-ai-tab-1' }), interactiveContext());
		const b = run(config({ sessionId: 'agent-abc-ai-tab-2' }), interactiveContext());

		expect(a.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).not.toBe(
			b.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]
		);
	});

	it('keeps the caller env vars it was given', () => {
		const result = applyLocalInteractiveSpawnDecision({
			config: config(),
			agent: null,
			claudeContext: interactiveContext(),
			commandToSpawn: 'claude',
			argsToSpawn: [],
			customEnvVarsToPass: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
		});

		expect(result.customEnvVarsToPass).toMatchObject({
			ANTHROPIC_BASE_URL: 'https://gateway.example',
			[STEERING_SOCKET_ENV_VAR]: steeringSocketPathFor(PROCESS_KEY),
		});
	});

	it('opens NO channel for an API-mode turn', () => {
		// `claude --print` closes stdin and holds no writable PTY for the turn, so
		// there is nothing to steer. A socket here would advertise a capability that
		// cannot work.
		const result = run(config(), interactiveContext({ claudeResolvedMode: 'api' }));

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
	});

	it('opens NO channel for an SSH-remote turn', () => {
		// The socket path is local; the TUI is on another host, where that path means
		// nothing. Remote steering would need the channel carried over the SSH
		// connection, which this does not do.
		const result = run(
			config({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
			} as Partial<SpawnProcessConfig>),
			interactiveContext()
		);

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
	});

	it('opens NO channel when no maestro-p binary was resolved', () => {
		const result = run(config(), interactiveContext({ resolvedMaestroPBinPath: undefined }));

		expect(result.customEnvVarsToPass?.[STEERING_SOCKET_ENV_VAR]).toBeUndefined();
	});
});
