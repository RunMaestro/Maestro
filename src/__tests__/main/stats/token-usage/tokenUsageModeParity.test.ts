// @vitest-environment jsdom
/**
 * Parity: the Usage Dashboard's token totals count a local, an SSH, and a hosted agent the same
 * way (rows I1, I2, I3 of the round 2 parity brief).
 *
 * The same conversations are read three ways: by this machine's own storage (local), and by the
 * remote's host answering `get_project_token_usage` over the wire (SSH and hosted), through the
 * real host answer, the real reply frame, and the real untrusted-input parser. Every number the
 * dashboard draws (totals, per agent, per model, per project, per day) must match, and the
 * "Not counted" note must stay empty. A host that cannot answer leaves the agent named, with no
 * mode word.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => path.join(os.tmpdir(), 'maestro-token-usage-parity-test')) },
}));
vi.mock('../../../../main/stats/singleton', () => ({ getStatsDB: vi.fn() }));
vi.mock('../../../../main/agents', () => ({ getSessionStorage: vi.fn() }));
vi.mock('../../../../main/agents/provider-account-dirs', () => ({
	getProviderAccountDirs: vi.fn(),
}));
vi.mock('../../../../main/stores/getters', () => ({ getLiveSessions: vi.fn() }));
vi.mock('../../../../main/stores/instances', () => ({ isInitialized: vi.fn(() => true) }));
vi.mock('../../../../main/federation', () => ({ getPeerMirrorService: vi.fn() }));

import {
	getTokenUsageAggregate,
	invalidateTokenUsageMemo,
} from '../../../../main/stats/token-usage/token-usage-accessor';
import { projectTokenUsage } from '../../../../main/stats/token-usage/project-breakdowns';
import {
	TokenUsageCache,
	setTokenUsageCacheForTest,
} from '../../../../main/stats/token-usage/token-usage-cache';
import { getStatsDB } from '../../../../main/stats/singleton';
import { getSessionStorage } from '../../../../main/agents';
import { getProviderAccountDirs } from '../../../../main/agents/provider-account-dirs';
import { getLiveSessions } from '../../../../main/stores/getters';
import { getPeerMirrorService } from '../../../../main/federation';
import { createHostTokenUsageAnswer } from '../../../../cli/services/host-token-usage';
import {
	parseProjectTokenUsageReply,
	projectTokenUsageRequest,
	type ProjectTokenUsageProject,
} from '../../../../shared/projectTokenUsage';
import type { AgentSessionInfo } from '../../../../main/agents/session-storage';
import type { TokenUsageAggregate } from '../../../../shared/tokenUsage';
import { tokenCoverageNotes } from '../../../../renderer/components/UsageDashboard/TokenStats';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../../helpers';

const PROJECT = '/home/dev/app';

function info(overrides: Partial<AgentSessionInfo>): AgentSessionInfo {
	return {
		sessionId: 's1',
		projectPath: PROJECT,
		firstMessage: '',
		messageCount: 2,
		timestamp: '2026-11-20T10:00:00Z',
		modifiedAt: '2026-11-20T10:00:00Z',
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		sizeBytes: 100,
		durationSeconds: 0,
		...overrides,
	} as AgentSessionInfo;
}

/** Two conversations on two days, two models: what one provider storage lists for the project. */
const CONVERSATIONS: AgentSessionInfo[] = [
	info({
		sessionId: 'c-1',
		origin: 'user',
		byModel: [
			{
				model: 'claude-opus-4-8',
				inputTokens: 1200,
				outputTokens: 300,
				cacheReadTokens: 9000,
				cacheCreationTokens: 400,
				costUsd: 0.75,
				costEstimated: true,
			},
		],
	}),
	info({
		sessionId: 'c-2',
		modifiedAt: '2026-11-22T15:30:00Z',
		origin: 'auto',
		byModel: [
			{
				model: 'claude-fable-5',
				inputTokens: 50,
				outputTokens: 80,
				cacheReadTokens: 0,
				cacheCreationTokens: 10,
				costUsd: 0.01,
				costEstimated: true,
			},
		],
	}),
];

const listSessions = vi.fn(async () => CONVERSATIONS);
const storage = { listSessions };

/** The host side, for real: its answer over the same storage, then the frame across the wire. */
async function hostAnswers(projects: ProjectTokenUsageProject[]) {
	const answer = createHostTokenUsageAnswer((asked) =>
		projectTokenUsage(asked, {
			storageFor: (agentType) => (agentType === 'claude-code' ? storage : null),
			accountDirsFor: async () => [],
		})
	);
	const frame = await answer(projectTokenUsageRequest(projects));
	return parseProjectTokenUsageReply(JSON.parse(JSON.stringify(frame)), projects);
}

function setMode(mode: AgentMode, peer: { answers: boolean } = { answers: true }): void {
	invalidateTokenUsageMemo();
	const cache = new TokenUsageCache(path.join(os.tmpdir(), 'maestro-token-parity-cache.json'));
	vi.spyOn(cache, 'load').mockResolvedValue(undefined);
	vi.spyOn(cache, 'persist').mockResolvedValue(undefined);
	setTokenUsageCacheForTest(cache);

	const agent = createModeSession(mode, {
		id: 'agent-1',
		name: 'Build Box',
		toolType: 'claude-code',
		cwd: PROJECT,
	});
	vi.mocked(getLiveSessions).mockReturnValue([agent] as never);
	vi.mocked(getStatsDB).mockReturnValue({
		isReady: () => true,
		getSessionLifecycleEvents: () => [
			{ agentType: 'claude-code', projectPath: PROJECT, isRemote: mode !== 'local' },
		],
		getTokenSpeedSources: () => [],
	} as unknown as ReturnType<typeof getStatsDB>);
	// This machine reads the project only for a local agent: the lifecycle row of a remote one is
	// skipped, so its storage is never asked about the remote path.
	vi.mocked(getSessionStorage).mockReturnValue(
		storage as unknown as ReturnType<typeof getSessionStorage>
	);
	vi.mocked(getProviderAccountDirs).mockResolvedValue([]);
	vi.mocked(getPeerMirrorService).mockReturnValue({
		projectTokenUsage: vi.fn(async (remoteId: string, projects: ProjectTokenUsageProject[]) =>
			remoteId === 'r1' && peer.answers ? hostAnswers(projects) : undefined
		),
	} as unknown as ReturnType<typeof getPeerMirrorService>);
}

/** Everything the Tokens tab and the token charts draw, without the clock. */
function drawn(aggregate: TokenUsageAggregate) {
	return {
		totals: aggregate.totals,
		byAgent: aggregate.byAgent,
		byModel: aggregate.byModel,
		byProject: aggregate.byProject,
		byAccount: aggregate.byAccount,
		timeline: aggregate.timeline,
		series: aggregate.series,
		coverageByAgent: aggregate.coverageByAgent,
		excluded: aggregate.excluded,
		notes: tokenCoverageNotes(aggregate),
	};
}

const QUERY = {
	sinceMs: Date.parse('2026-11-19T00:00:00Z'),
	untilMs: Date.parse('2026-11-24T00:00:00Z'),
};

describe('token totals count a local, an SSH, and a hosted agent the same', () => {
	beforeEach(() => {
		listSessions.mockClear();
	});

	it('draws the same totals, rows, and per-day series in every mode', async () => {
		const results: Record<AgentMode, ReturnType<typeof drawn>> = {} as never;
		for (const mode of AGENT_MODES) {
			setMode(mode);
			results[mode] = drawn(await getTokenUsageAggregate(QUERY, true, { waitForRemote: true }));
		}
		expect(results.local.totals.sessionCount).toBe(2);
		expect(results.local.totals.inputTokens).toBe(1250);
		expect(results.local.excluded).toEqual({
			unsupportedAgents: [],
			remoteProjects: 0,
			notCountedAgents: [],
			pendingAgents: [],
			remoteRefreshing: false,
			partialAgents: [],
		});
		expect(results.local.notes.join(' ')).not.toContain('Not counted');
		expect(results.ssh).toEqual(results.local);
		expect(results.hosted).toEqual(results.local);
	});

	it('names an agent whose computer cannot answer, with no mode word, in both remote modes', async () => {
		const notes: Record<string, string> = {};
		for (const mode of ['ssh', 'hosted'] as const) {
			setMode(mode, { answers: false });
			const aggregate = await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			expect(aggregate.totals.sessionCount).toBe(0);
			expect(aggregate.excluded.notCountedAgents).toEqual(['Build Box']);
			expect(aggregate.excluded.remoteProjects).toBe(0);
			notes[mode] = tokenCoverageNotes(aggregate).join(' ');
		}
		expect(notes.ssh).toBe(notes.hosted);
		expect(notes.ssh).toContain(
			'Not counted: Build Box (conversations on another computer that could not be read).'
		);
		expect(notes.ssh).not.toMatch(/SSH|remote|hosted|federation/i);
	});

	it('names an agent whose host could not read its conversations, instead of counting it short', async () => {
		for (const mode of ['ssh', 'hosted'] as const) {
			setMode(mode);
			listSessions.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
			const aggregate = await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			expect(aggregate.totals.sessionCount).toBe(0);
			expect(aggregate.excluded.notCountedAgents).toEqual(['Build Box']);
		}
	});

	it('counts a removed agent on another computer as one group, never by mode', async () => {
		setMode('ssh');
		vi.mocked(getLiveSessions).mockReturnValue([]);
		const aggregate = await getTokenUsageAggregate(QUERY, true);
		expect(aggregate.excluded.remoteProjects).toBe(1);
		expect(aggregate.excluded.notCountedAgents).toEqual([]);
		expect(tokenCoverageNotes(aggregate).join(' ')).toContain('1 removed agent');
	});

	it('returns local totals at once while a slow host is still counting, then fills the remote rows in', async () => {
		for (const mode of ['ssh', 'hosted'] as const) {
			setMode(mode);
			// A local agent beside the remote one: its own row in the activity record.
			vi.mocked(getStatsDB).mockReturnValue({
				isReady: () => true,
				getSessionLifecycleEvents: () => [
					{ agentType: 'claude-code', projectPath: '/local/app', isRemote: false },
					{ agentType: 'claude-code', projectPath: PROJECT, isRemote: true },
				],
				getTokenSpeedSources: () => [],
			} as unknown as ReturnType<typeof getStatsDB>);
			let release: () => void = () => undefined;
			const answered = new Promise<void>((resolve) => (release = resolve));
			const projectTokenUsageMock = vi.fn(
				async (_remoteId: string, projects: ProjectTokenUsageProject[]) => {
					await answered;
					return hostAnswers(projects);
				}
			);
			vi.mocked(getPeerMirrorService).mockReturnValue({
				projectTokenUsage: projectTokenUsageMock,
			} as unknown as ReturnType<typeof getPeerMirrorService>);

			// The host has not answered, and the read does not wait for it.
			const first = await getTokenUsageAggregate(QUERY, true);
			await vi.waitFor(() => expect(projectTokenUsageMock).toHaveBeenCalledTimes(1));
			expect(first.totals.sessionCount).toBe(2);
			expect(first.excluded.pendingAgents).toEqual(['Build Box']);
			expect(first.excluded.notCountedAgents).toEqual([]);
			expect(first.excluded.remoteRefreshing).toBe(true);
			const note = tokenCoverageNotes(first).join(' ');
			expect(note).toContain('Build Box (conversations on another computer, still being read)');
			expect(note).not.toMatch(/SSH|remote|hosted|federation/i);

			// The dashboard's second read waits, and the remote rows land.
			const waited = getTokenUsageAggregate(QUERY, false, { waitForRemote: true });
			release();
			const full = await waited;
			expect(projectTokenUsageMock).toHaveBeenCalledTimes(1);
			expect(full.totals.sessionCount).toBe(4);
			expect(full.excluded.pendingAgents).toEqual([]);
			expect(full.excluded.remoteRefreshing).toBe(false);

			// A later refresh serves the last remote count at once while it asks again.
			let releaseAgain: () => void = () => undefined;
			const again = new Promise<void>((resolve) => (releaseAgain = resolve));
			projectTokenUsageMock.mockImplementationOnce(async (_remoteId, projects) => {
				await again;
				return hostAnswers(projects);
			});
			const stale = await getTokenUsageAggregate(QUERY, true);
			expect(stale.totals.sessionCount).toBe(4);
			expect(stale.excluded.pendingAgents).toEqual([]);
			expect(stale.excluded.remoteRefreshing).toBe(true);
			releaseAgain();
			const refreshed = await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			expect(refreshed.totals.sessionCount).toBe(4);
			expect(refreshed.excluded.remoteRefreshing).toBe(false);
		}
	});

	it('counts the rest and names the agent when a conversation is too large to read, the same in every mode', async () => {
		const notes: Record<string, string> = {};
		const totals: Record<string, number> = {};
		for (const mode of AGENT_MODES) {
			setMode(mode);
			listSessions.mockImplementation((async (
				_projectPath: string,
				_ssh: unknown,
				_account: unknown,
				observer?: { onSkippedFile?(file: { sizeBytes: number; reason: 'too-large' }): void }
			) => {
				observer?.onSkippedFile?.({ sizeBytes: 200 * 1024 * 1024, reason: 'too-large' });
				return CONVERSATIONS;
			}) as never);
			const aggregate = await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			totals[mode] = aggregate.totals.sessionCount;
			expect(aggregate.excluded.partialAgents).toEqual([{ name: 'Build Box', conversations: 1 }]);
			expect(aggregate.excluded.notCountedAgents).toEqual([]);
			notes[mode] = tokenCoverageNotes(aggregate).join(' ');
		}
		listSessions.mockImplementation(async () => CONVERSATIONS);
		expect(totals).toEqual({ local: 2, ssh: 2, hosted: 2 });
		expect(notes.ssh).toBe(notes.local);
		expect(notes.hosted).toBe(notes.local);
		expect(notes.local).toContain(
			'Not counted: 1 conversation of Build Box (too large or unreadable).'
		);
		expect(notes.local).not.toMatch(/SSH|remote|hosted|federation/i);
	});

	it('names an agent whose conversations could not be listed at all, in every mode, with no mode word', async () => {
		for (const mode of AGENT_MODES) {
			setMode(mode);
			listSessions.mockImplementation(async () =>
				Promise.reject(Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }))
			);
			const aggregate = await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			expect(aggregate.totals.sessionCount).toBe(0);
			const named =
				mode === 'local' ? aggregate.excluded.unreadAgents : aggregate.excluded.notCountedAgents;
			expect(named).toEqual(['Build Box']);
			const note = tokenCoverageNotes(aggregate).join(' ');
			expect(note).toMatch(/Not counted: Build Box \(conversations .*could not be read\)\./);
			expect(note).not.toMatch(/SSH|remote|hosted|federation/i);
		}
		listSessions.mockImplementation(async () => CONVERSATIONS);
	});

	describe('the remote count kept apart', () => {
		/** A host that answers only when released, and how often it was asked. */
		function slowHost() {
			const releases: Array<() => void> = [];
			const ask = vi.fn(async (_remoteId: string, projects: ProjectTokenUsageProject[]) => {
				await new Promise<void>((resolve) => releases.push(resolve));
				return hostAnswers(projects);
			});
			vi.mocked(getPeerMirrorService).mockReturnValue({
				projectTokenUsage: ask,
			} as unknown as ReturnType<typeof getPeerMirrorService>);
			const releaseAll = async () => {
				await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
				while (releases.length) releases.shift()!();
			};
			return { ask, releaseAll };
		}

		function agentAt(cwd: string, id = 'agent-1', name = 'Build Box') {
			return createModeSession('hosted', { id, name, toolType: 'claude-code', cwd });
		}

		it('does not reuse the count of an agent whose working directory moved', async () => {
			setMode('hosted');
			await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			vi.mocked(getLiveSessions).mockReturnValue([agentAt('/home/dev/other')] as never);
			const host = slowHost();
			const moved = await getTokenUsageAggregate(QUERY, false);
			expect(moved.excluded.pendingAgents).toEqual(['Build Box']);
			expect(moved.excluded.remoteRefreshing).toBe(true);
			// The old folder's conversations are not shown for the moved agent.
			expect(moved.totals.sessionCount).toBe(0);
			await host.releaseAll();
			await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
		});

		it('a waited read covers an agent added while an older refresh was running', async () => {
			setMode('hosted');
			const host = slowHost();
			const background = getTokenUsageAggregate(QUERY, true);
			await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));
			vi.mocked(getLiveSessions).mockReturnValue([
				agentAt(PROJECT),
				agentAt('/home/dev/second', 'agent-2', 'Second Box'),
			] as never);
			const waited = getTokenUsageAggregate(QUERY, false, { waitForRemote: true });
			await host.releaseAll();
			await host.releaseAll();
			const full = await waited;
			await background;
			expect(full.excluded.pendingAgents).toEqual([]);
			expect(full.excluded.remoteRefreshing).toBe(false);
		});

		it('leaves a removed agent out of the count it serves while refreshing', async () => {
			setMode('hosted');
			await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			vi.mocked(getLiveSessions).mockReturnValue([
				agentAt('/home/dev/second', 'agent-2', 'Second Box'),
			] as never);
			const host = slowHost();
			const served = await getTokenUsageAggregate(QUERY, true);
			expect(served.totals.sessionCount).toBe(0);
			expect(served.excluded.pendingAgents).toEqual(['Second Box']);
			await host.releaseAll();
			await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
		});

		it('a read during a forced refresh of a fresh count says it is refreshing, and a waited one joins it', async () => {
			setMode('hosted');
			await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
			const host = slowHost();
			const forced = await getTokenUsageAggregate(QUERY, true);
			expect(forced.excluded.remoteRefreshing).toBe(true);
			await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));
			// The count is still fresh, but a newer one is being read.
			const shown = await getTokenUsageAggregate(QUERY, false);
			expect(shown.excluded.remoteRefreshing).toBe(true);
			let settled = false;
			const waited = getTokenUsageAggregate(QUERY, false, { waitForRemote: true }).then((r) => {
				settled = true;
				return r;
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(settled).toBe(false);
			await host.releaseAll();
			const full = await waited;
			expect(full.excluded.remoteRefreshing).toBe(false);
			expect(host.ask).toHaveBeenCalledTimes(1);
		});

		it('a refresh started before an invalidation does not fill the memo after it', async () => {
			setMode('hosted');
			const host = slowHost();
			await getTokenUsageAggregate(QUERY, true);
			await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(1));
			invalidateTokenUsageMemo();
			await host.releaseAll();
			await new Promise((resolve) => setTimeout(resolve, 0));
			// Nothing fresh is remembered: the next read asks again.
			const next = await getTokenUsageAggregate(QUERY, false);
			expect(next.excluded.remoteRefreshing).toBe(true);
			await vi.waitFor(() => expect(host.ask).toHaveBeenCalledTimes(2));
			await host.releaseAll();
			await getTokenUsageAggregate(QUERY, true, { waitForRemote: true });
		});
	});
});
