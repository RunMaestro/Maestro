/**
 * Tests for the playbook facts pack: every probe is mocked, so these pin the
 * wiring (which host runs which probe) and the best-effort contract (a
 * missing tool is `false`, an unreachable host is unknown, nothing throws).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExecResult } from '../../../main/utils/execFile';
import type { SshRemoteConfig } from '../../../shared/types';

vi.mock('../../../main/utils/remote-git', () => ({
	execGitReadOnly: vi.fn(),
	execShellRemote: vi.fn(),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../../main/utils/cliDetection', () => ({ getExpandedEnv: () => ({ PATH: '/bin' }) }));
vi.mock('../../../main/utils/gh-command', () => ({ resolveConfiguredGhCommand: vi.fn() }));
vi.mock('../../../main/stores/getters', () => ({
	getLiveSessions: vi.fn(() => []),
	getSettingsStore: vi.fn(() => ({ get: vi.fn() })),
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { execGitReadOnly, execShellRemote } from '../../../main/utils/remote-git';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { captureException } from '../../../main/utils/sentry';
import { gatherPlaybookFacts, type PlaybookFactsDeps } from '../../../main/services/playbook-facts';
import type { StoredSession } from '../../../main/stores/types';

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (exitCode: number | string = 1): ExecResult => ({ stdout: '', stderr: 'x', exitCode });

const REMOTE: SshRemoteConfig = {
	id: 'r1',
	name: 'Box',
	host: 'box',
	port: 22,
	username: 'me',
	privateKeyPath: '',
	enabled: true,
} as SshRemoteConfig;

function session(overrides: Partial<StoredSession> = {}): StoredSession {
	return {
		id: 'a1',
		name: 'A',
		toolType: 'claude-code',
		cwd: '/work/repo',
		projectRoot: '/work/repo',
		...overrides,
	};
}

function deps(overrides: Partial<PlaybookFactsDeps> = {}): PlaybookFactsDeps {
	return {
		getSession: (id) => (id === 'a1' ? session() : undefined),
		getSshRemotes: () => [REMOTE],
		getEncoreFeatures: () => ({ maestroCue: false }),
		getCueStatus: () => [
			{ sessionId: 'a1', subscriptionCount: 3 } as never,
			{ sessionId: 'other', subscriptionCount: 9 } as never,
		],
		resolveGhCommand: async () => '/opt/gh',
		...overrides,
	};
}

/** Local git answers by the first argument after the subcommand. */
function mockGit(branch: ExecResult, remote: ExecResult): void {
	vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
		args[0] === 'rev-parse' ? branch : remote
	);
}

/** Local exec answers: `--version` probes by command, and `gh pr list`. */
function mockLocalExec(answers: { gh?: boolean; python3?: boolean; prList?: ExecResult }): void {
	vi.mocked(execFileNoThrow).mockImplementation(async (command, args = []) => {
		if (args[0] === '--version') {
			const runs =
				command === '/opt/gh' ? answers.gh : command === 'python3' ? answers.python3 : false;
			return runs ? ok('v1') : fail('ENOENT');
		}
		if (args[0] === 'pr') return answers.prList ?? ok('[]');
		return fail();
	});
}

describe('gatherPlaybookFacts', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('gathers local git, tools, open PRs, Encore flags, and the Cue count', async () => {
		mockGit(ok('feat/x\n'), ok('https://github.com/acme/repo.git\n'));
		mockLocalExec({
			gh: true,
			python3: true,
			prList: ok(JSON.stringify([{ url: 'https://github.com/acme/repo/pull/7' }, { nope: 1 }])),
		});

		const facts = await gatherPlaybookFacts('a1', deps());

		expect(facts).toMatchObject({
			cwd: '/work/repo',
			isSshRemote: false,
			gitBranch: 'feat/x',
			gitRemoteUrl: 'https://github.com/acme/repo.git',
			openPrUrlsForBranch: ['https://github.com/acme/repo/pull/7'],
			hasGh: true,
			hasPython3: true,
			unknownProbes: [],
			cueSubscriptionCount: 3,
		});
		expect(facts.encoreFlags.maestroCue).toBe(false);
		expect(facts.encoreFlags.directorNotes).toBe(true);
		expect(execGitReadOnly).toHaveBeenCalledWith(
			['rev-parse', '--abbrev-ref', 'HEAD'],
			'/work/repo',
			undefined,
			undefined,
			expect.any(Number)
		);
		// The local PR lookup asks from the agent's folder, not by repo URL.
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'/opt/gh',
			['pr', 'list', '--head', 'feat/x', '--state', 'open', '--json', 'url'],
			'/work/repo',
			expect.objectContaining({ timeout: expect.any(Number) })
		);
	});

	it('reports a missing tool as false, not an error, and skips the PR lookup', async () => {
		mockGit(ok('feat/x'), ok('git@github.com:acme/repo.git'));
		mockLocalExec({ gh: false, python3: false });

		const facts = await gatherPlaybookFacts('a1', deps());

		expect(facts.hasGh).toBe(false);
		expect(facts.hasPython3).toBe(false);
		expect(facts.unknownProbes).toEqual([]);
		expect(facts.openPrUrlsForBranch).toEqual([]);
		expect(vi.mocked(execFileNoThrow).mock.calls.some(([, args]) => args?.[0] === 'pr')).toBe(
			false
		);
	});

	it('treats a folder outside a repo and a detached HEAD as no branch', async () => {
		mockGit(ok('HEAD'), fail(2));
		mockLocalExec({ gh: true, python3: true });

		const facts = await gatherPlaybookFacts('a1', deps());

		expect(facts.gitBranch).toBeUndefined();
		expect(facts.gitRemoteUrl).toBeUndefined();
		expect(facts.unknownProbes).toEqual([]);
		expect(facts.openPrUrlsForBranch).toEqual([]);
	});

	it('ignores gh output that is not JSON', async () => {
		mockGit(ok('feat/x'), ok('u'));
		mockLocalExec({ gh: true, python3: true, prList: ok('warning: upgrade gh') });

		expect((await gatherPlaybookFacts('a1', deps())).openPrUrlsForBranch).toEqual([]);
	});

	it('runs git and tool probes on the SSH remote and looks up PRs by repo URL', async () => {
		const remoteSession = session({
			sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', workingDirOverride: '/srv/repo' },
		});
		mockGit(ok('feat/remote'), ok('https://github.com/acme/remote.git'));
		vi.mocked(execShellRemote).mockResolvedValue(ok('python3\n'));
		mockLocalExec({
			gh: true,
			prList: ok(JSON.stringify([{ url: 'https://github.com/acme/remote/pull/3' }])),
		});

		const facts = await gatherPlaybookFacts('a1', deps({ getSession: () => remoteSession }));

		expect(facts).toMatchObject({
			cwd: '/srv/repo',
			isSshRemote: true,
			gitBranch: 'feat/remote',
			hasGh: false,
			hasPython3: true,
			unknownProbes: [],
			openPrUrlsForBranch: ['https://github.com/acme/remote/pull/3'],
		});
		expect(execGitReadOnly).toHaveBeenCalledWith(
			['rev-parse', '--abbrev-ref', 'HEAD'],
			'/work/repo',
			REMOTE,
			'/srv/repo',
			expect.any(Number)
		);
		expect(execShellRemote).toHaveBeenCalledWith(expect.stringContaining('command -v gh'), REMOTE, {
			timeoutMs: expect.any(Number),
		});
		// python3 is never probed locally for a remote agent.
		expect(vi.mocked(execFileNoThrow).mock.calls.some(([command]) => command === 'python3')).toBe(
			false
		);
		expect(execFileNoThrow).toHaveBeenCalledWith(
			'/opt/gh',
			[
				'pr',
				'list',
				'--head',
				'feat/remote',
				'--state',
				'open',
				'--json',
				'url',
				'--repo',
				'https://github.com/acme/remote.git',
			],
			undefined,
			expect.any(Object)
		);
	});

	it('reports remote probes as unknown when SSH cannot reach the host', async () => {
		const remoteSession = session({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } });
		mockGit(fail(255), fail(255));
		vi.mocked(execShellRemote).mockResolvedValue(fail(255));
		mockLocalExec({ gh: true, python3: true });

		const facts = await gatherPlaybookFacts('a1', deps({ getSession: () => remoteSession }));

		expect(facts.isSshRemote).toBe(true);
		expect(facts.gitBranch).toBeUndefined();
		expect(facts.hasGh).toBe(false);
		expect(facts.hasPython3).toBe(false);
		expect(facts.unknownProbes.sort()).toEqual(['gh', 'git', 'python3']);
		expect(facts.openPrUrlsForBranch).toEqual([]);
	});

	it('never answers from this machine when the SSH remote is unresolved', async () => {
		const remoteSession = session({ sessionSshRemoteConfig: { enabled: true, remoteId: 'gone' } });

		const facts = await gatherPlaybookFacts('a1', deps({ getSession: () => remoteSession }));

		expect(facts.isSshRemote).toBe(true);
		expect(facts.unknownProbes).toEqual(['git', 'gh', 'python3']);
		expect(execGitReadOnly).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('returns empty facts for an unknown agent', async () => {
		const facts = await gatherPlaybookFacts('missing', deps());

		expect(facts).toMatchObject({
			cwd: '',
			isSshRemote: false,
			unknownProbes: ['git', 'gh', 'python3'],
			cueSubscriptionCount: 0,
		});
		expect(execGitReadOnly).not.toHaveBeenCalled();
	});

	it('never rejects: a throwing probe falls back and is reported to Sentry', async () => {
		vi.mocked(execGitReadOnly).mockRejectedValue(new Error('boom'));
		mockLocalExec({ gh: true, python3: true });

		const facts = await gatherPlaybookFacts(
			'a1',
			deps({
				getCueStatus: () => {
					throw new Error('cue down');
				},
			})
		);

		expect(facts.unknownProbes).toEqual(['git']);
		expect(facts.cueSubscriptionCount).toBe(0);
		expect(facts.hasGh).toBe(true);
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'playbookFacts:git',
		});
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			operation: 'playbookFacts:cue',
		});
	});

	it('counts zero Cue subscriptions when Cue is not running', async () => {
		mockGit(fail(), fail());
		mockLocalExec({});

		const facts = await gatherPlaybookFacts('a1', deps({ getCueStatus: () => null }));

		expect(facts.cueSubscriptionCount).toBe(0);
	});
});
