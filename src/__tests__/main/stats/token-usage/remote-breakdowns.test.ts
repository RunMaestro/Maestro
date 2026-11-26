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
import { projectTokenUsage } from '../../../../main/stats/token-usage/project-breakdowns';
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

/** A host answer: each project of the request read whole, with `byProject` conversations. */
function answered(
	projects: Array<{ projectPath: string }>,
	byProject: (projectPath: string) => SessionTokenBreakdown[] = () => []
) {
	return {
		projects: projects.map(({ projectPath }) => ({
			status: 'read' as const,
			breakdowns: byProject(projectPath),
			complete: true,
		})),
	};
}

describe('collectRemoteBreakdowns', () => {
	it('asks each remote once for its projects and merges the answers', async () => {
		const request = vi.fn(
			async (remoteId: string, projects: Array<{ projectPath: string }>, _timeoutMs: number) =>
				answered(projects, (projectPath) =>
					remoteId === 'r1' ? [breakdown('s1'), breakdown('s1')] : [breakdown('s2', projectPath)]
				)
		);
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

	it('asks a remote with more projects than a host reads per request in chunks, and counts each chunk on its own', async () => {
		const many = Array.from({ length: 70 }, (_, i) =>
			agent({ id: `a${i}`, name: `A${i}`, projectPath: `/p/${i}` })
		);
		const request = vi.fn(
			async (_remoteId: string, projects: Array<{ projectPath: string }>, _timeoutMs: number) =>
				projects.length === 64
					? answered(projects, (path) => (path === '/p/0' ? [breakdown('s0', '/p/0')] : []))
					: undefined
		);
		const result = await collectRemoteBreakdowns(many, request);
		expect(request.mock.calls.map(([, projects]) => projects.length)).toEqual([64, 6]);
		expect(result.breakdowns.map((b) => b.sessionId)).toEqual(['s0']);
		expect(result.notCounted.map((a) => a.id)).toEqual(
			Array.from({ length: 6 }, (_, i) => `a${64 + i}`)
		);
	});

	it('reports a remote done only once its last chunk settles, whichever order they finish in', async () => {
		const many = Array.from({ length: 70 }, (_, i) =>
			agent({ id: `a${i}`, projectPath: `/p/${i}` })
		);
		let releaseBig!: () => void;
		const big = new Promise<void>((resolve) => (releaseBig = resolve));
		const onRemoteDone = vi.fn();
		const pending = collectRemoteBreakdowns(
			many,
			async (_remoteId, projects) => {
				if (projects.length === 64) await big;
				return answered(projects);
			},
			{ onRemoteDone }
		);
		// The six-project chunk answers first; the remote is not done yet.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onRemoteDone).not.toHaveBeenCalled();
		releaseBig();
		await pending;
		expect(onRemoteDone).toHaveBeenCalledTimes(1);
	});

	it('names an agent whose project its host failed to read, cut short, or cannot read, and merges none of it', async () => {
		const result = await collectRemoteBreakdowns(
			[
				agent({ id: 'failed', projectPath: '/f' }),
				agent({ id: 'cut', projectPath: '/c' }),
				agent({ id: 'other', provider: 'opencode', projectPath: '/o' }),
				agent({ id: 'fine', projectPath: '/ok' }),
			],
			async () => ({
				projects: [
					{ status: 'failed' as const, breakdowns: [], complete: false },
					{ status: 'read' as const, breakdowns: [breakdown('partial', '/c')], complete: false },
					{ status: 'unsupported' as const, breakdowns: [], complete: false },
					{ status: 'read' as const, breakdowns: [breakdown('s1', '/ok')], complete: true },
				],
			})
		);
		expect(result.notCounted.map((a) => a.id)).toEqual(['failed', 'cut', 'other']);
		expect(result.breakdowns.map((b) => b.sessionId)).toEqual(['s1']);
	});

	it('names every agent whose remote did not answer, answered late, or threw', async () => {
		vi.useFakeTimers();
		try {
			const onError = vi.fn();
			const pending = collectRemoteBreakdowns(
				[
					agent({ id: 'down', remoteId: 'down' }),
					agent({ id: 'slow', remoteId: 'slow' }),
					agent({ id: 'broken', remoteId: 'broken' }),
					agent({ id: 'fine', remoteId: 'ok' }),
				],
				async (remoteId, projects) => {
					if (remoteId === 'down') return undefined;
					if (remoteId === 'slow') return new Promise(() => undefined);
					if (remoteId === 'broken') throw new Error('bug');
					return answered(projects, () => [breakdown('s1')]);
				},
				{ timeoutMs: 1000, onError }
			);
			await vi.advanceTimersByTimeAsync(1000);
			const result = await pending;
			expect(result.notCounted.map((a) => a.id)).toEqual(['down', 'slow', 'broken']);
			expect(result.breakdowns.map((b) => b.sessionId)).toEqual(['s1']);
			expect(onError).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe('one conversation under two folders asked', () => {
	it('counts a rollout once when agents at a parent and a child folder both hold it, in either order', async () => {
		const agents = [
			agent({ id: 'parent', name: 'Parent', provider: 'codex', projectPath: '/srv/app' }),
			agent({ id: 'child', name: 'Child', provider: 'codex', projectPath: '/srv/app/pkg' }),
		];
		for (const order of [agents, [...agents].reverse()]) {
			const merged = await collectRemoteBreakdowns(order, async (_remoteId, projects) => ({
				projects: projects.map((project) => ({
					status: 'read' as const,
					complete: true,
					breakdowns: [{ ...breakdown('rollout-1', project.projectPath), agentType: 'codex' }],
				})),
			}));
			expect(merged.breakdowns.map((b) => [b.sessionId, b.projectPath])).toEqual([
				['rollout-1', '/srv/app/pkg'],
			]);
			expect(merged.notCounted).toEqual([]);
		}
	});
});

describe('projectTokenUsage (the host side)', () => {
	it('answers per project in the order asked, and a project a storage failed to list as failed', async () => {
		const listSessions = vi.fn(async (projectPath: string, _ssh: unknown, account?: string) => {
			if (projectPath === '/bad' && account === '/acct/2') throw new Error('EACCES');
			return [];
		});
		const usage = await projectTokenUsage(
			[
				{ provider: 'claude-code', projectPath: '/ok' },
				{ provider: 'claude-code', projectPath: '/bad' },
				{ provider: 'opencode', projectPath: '/ok' },
			],
			{
				storageFor: (agentType) => (agentType === 'claude-code' ? { listSessions } : null),
				accountDirsFor: async () => ['/acct/1', '/acct/2'],
			}
		);
		expect(usage.projects.map((p) => [p.status, p.complete])).toEqual([
			['read', true],
			['failed', false],
			['unsupported', false],
		]);
	});

	it('answers a conversation in a folder under the one asked as that folder, never with its own path', async () => {
		// Codex matches a project by prefix: asked for `/`, its storage lists every rollout.
		const listSessions = vi.fn(async () => [
			{
				sessionId: 'r1',
				projectPath: '/home/dev/secret-client/app',
				timestamp: '2026-11-20T10:00:00Z',
				modifiedAt: '2026-11-20T10:00:00Z',
				inputTokens: 5,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				sizeBytes: 1,
			},
		]);
		const usage = await projectTokenUsage([{ provider: 'codex', projectPath: '/' }], {
			storageFor: () => ({ listSessions }) as never,
			accountDirsFor: async () => [],
		});
		expect(usage.projects[0].breakdowns.map((b) => b.projectPath)).toEqual(['/']);
		expect(JSON.stringify(usage)).not.toContain('secret-client');
	});
});
