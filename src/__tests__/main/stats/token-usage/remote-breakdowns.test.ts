/**
 * The requester side of the token totals for agents on another computer: one bounded ask per
 * remote, merged numbers, and every agent that could not be read named.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	collectRemoteBreakdowns,
	remoteTokenAgentsOf,
	type RemoteTokenAgent,
} from '../../../../main/stats/token-usage/remote-breakdowns';
import type { AgentRecord } from '../../../../shared/maestro-lib/store/records';
import type { SessionTokenBreakdown } from '../../../../shared/tokenUsage';
import { AGENT_MODES, createModeSession } from '../../../helpers/mockSession';

function agent(overrides: Partial<RemoteTokenAgent> = {}): RemoteTokenAgent {
	return {
		id: 'a1',
		name: 'One',
		provider: 'claude-code',
		remoteId: 'r1',
		projectPath: '/srv/app',
		...overrides,
	};
}

function breakdown(sessionId: string, projectPath = '/srv/app'): SessionTokenBreakdown {
	return {
		sessionId,
		agentType: 'claude-code',
		projectPath,
		accountKey: 'default',
		timestampMs: 1,
		byModel: [],
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0,
		costEstimated: false,
		coverage: 'full',
	};
}

describe('remoteTokenAgentsOf', () => {
	it('takes an SSH and a hosted agent the same way, and never a local one', () => {
		const records = AGENT_MODES.map((mode) =>
			createModeSession(mode, { id: mode, name: mode, toolType: 'codex', cwd: '/srv/app' })
		) as unknown as AgentRecord[];
		expect(remoteTokenAgentsOf(records)).toEqual(
			['ssh', 'hosted'].map((id) => ({
				id,
				name: id,
				provider: 'codex',
				remoteId: 'r1',
				projectPath: '/srv/app',
			}))
		);
	});

	it('uses the remote working directory override, and skips the terminal', () => {
		const ssh = createModeSession('ssh', {
			id: 'x',
			toolType: 'claude-code',
			cwd: '/local/path',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: '/remote/path' },
		} as never);
		const terminal = createModeSession('ssh', { id: 't', toolType: 'terminal', cwd: '/x' });
		const agents = remoteTokenAgentsOf([ssh, terminal] as unknown as AgentRecord[]);
		expect(agents.map((a) => a.projectPath)).toEqual(['/remote/path']);
	});
});

describe('collectRemoteBreakdowns', () => {
	it('asks each remote once for its projects and merges the answers', async () => {
		const request = vi.fn(async (remoteId: string, _projects: unknown, _timeoutMs: number) => ({
			breakdowns: remoteId === 'r1' ? [breakdown('s1'), breakdown('s1')] : [breakdown('s2', '/b')],
			unsupportedProviders: [],
		}));
		const result = await collectRemoteBreakdowns(
			[
				agent(),
				agent({ id: 'a2', name: 'Two' }),
				agent({ id: 'a3', remoteId: 'r2', projectPath: '/b' }),
			],
			request
		);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0][1]).toEqual([
			{ provider: 'claude-code', projectPath: '/srv/app' },
		]);
		expect(result.breakdowns.map((b) => b.sessionId)).toEqual(['s1', 's2']);
		expect(result.notCounted).toEqual([]);
	});

	it('names every agent whose remote did not answer, answered late, threw, or cannot read its provider', async () => {
		vi.useFakeTimers();
		try {
			const onError = vi.fn();
			const pending = collectRemoteBreakdowns(
				[
					agent({ id: 'down', remoteId: 'down' }),
					agent({ id: 'slow', remoteId: 'slow' }),
					agent({ id: 'broken', remoteId: 'broken' }),
					agent({ id: 'other', remoteId: 'ok', provider: 'opencode' }),
					agent({ id: 'fine', remoteId: 'ok' }),
				],
				async (remoteId) => {
					if (remoteId === 'down') return undefined;
					if (remoteId === 'slow') return new Promise(() => undefined);
					if (remoteId === 'broken') throw new Error('bug');
					return { breakdowns: [breakdown('s1')], unsupportedProviders: ['opencode'] };
				},
				{ timeoutMs: 1000, onError }
			);
			await vi.advanceTimersByTimeAsync(1000);
			const result = await pending;
			expect(result.notCounted.map((a) => a.id)).toEqual(['down', 'slow', 'broken', 'other']);
			expect(result.breakdowns.map((b) => b.sessionId)).toEqual(['s1']);
			expect(onError).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
