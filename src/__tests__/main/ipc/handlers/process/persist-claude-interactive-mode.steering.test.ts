/**
 * @file persist-claude-interactive-mode.steering.test.ts
 * @description Parity F1: a TUI turn on an SSH remote whose maestro-p predates the
 * steering relay records `steeringUnavailable: 'maestro-p-outdated'` with its mode,
 * on the agent record and on the renderer event, so the Steer controls name the
 * cause. Every other spawn clears it.
 */

import { describe, expect, it, vi } from 'vitest';

import { persistClaudeInteractiveMode } from '../../../../../main/ipc/handlers/process/persist-claude-interactive-mode';
import type { ClaudeSpawnContext } from '../../../../../main/ipc/handlers/process/resolve-claude-spawn-context';
import type { SpawnProcessConfig } from '../../../../../main/ipc/handlers/process/spawn-types';

vi.mock('../../../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

function context(overrides: Partial<ClaudeSpawnContext>): ClaudeSpawnContext {
	return {
		isClaudeCode: true,
		isSshEnabled: true,
		baseSessionId: 's1',
		tokenSourceSessionId: 's1',
		claudeResolvedMode: 'interactive',
		claudeResolvedReason: 'auto',
		resolvedMaestroPBinPath: null,
		resolvedConfigDirKey: 'default',
		claudeDecisionRealBinPath: undefined,
		claudeResolvedRemote: true,
		acceptWorkspaceTrust: false,
		...overrides,
	};
}

function run(ctx: ClaudeSpawnContext, initial: Record<string, unknown>) {
	let sessions: unknown[] = [{ id: 's1', ...initial }];
	const sessionsStore = {
		get: () => sessions,
		set: (_key: string, value: unknown[]) => {
			sessions = value;
		},
	};
	const safeSend = vi.fn();
	persistClaudeInteractiveMode({ sessionId: 's1-ai-tab-1' } as SpawnProcessConfig, ctx, {
		sessionsStore: sessionsStore as never,
		safeSend,
		getMainWindow: () => null,
	});
	return {
		record: (sessions[0] as { claudeInteractive?: Record<string, unknown> }).claudeInteractive,
		payload: safeSend.mock.calls[0]?.[2] as Record<string, unknown>,
	};
}

describe('persistClaudeInteractiveMode steering write-back', () => {
	it('records an SSH remote whose maestro-p cannot relay a steer', () => {
		const { record, payload } = run(context({ remoteMaestroPCanSteer: false }), {});
		expect(record).toMatchObject({
			mode: 'interactive',
			steeringUnavailable: 'maestro-p-outdated',
		});
		expect(payload).toMatchObject({
			mode: 'interactive',
			steeringUnavailable: 'maestro-p-outdated',
		});
	});

	it('clears a stale record once the remote can steer', () => {
		const { record, payload } = run(context({ remoteMaestroPCanSteer: true }), {
			claudeInteractive: {
				mode: 'interactive',
				modeReason: 'auto',
				lastUsageSnapshotKey: 'default',
				steeringUnavailable: 'maestro-p-outdated',
			},
		});
		expect(record).toEqual({
			mode: 'interactive',
			modeReason: 'auto',
			lastUsageSnapshotKey: 'default',
		});
		expect(payload).not.toHaveProperty('steeringUnavailable');
	});

	it('never records it for a local turn', () => {
		const { record } = run(context({ isSshEnabled: false, claudeResolvedRemote: false }), {});
		expect(record).not.toHaveProperty('steeringUnavailable');
	});
});
