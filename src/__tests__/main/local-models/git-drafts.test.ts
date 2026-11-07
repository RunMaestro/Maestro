/**
 * @file git-drafts.test.ts
 * @description The Git drafts service: every task router verdict, what it reads
 * from git, and that a request from IPC or the CLI bridge is checked before
 * anything runs. Nothing here may fall back to an agent or touch a remote.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => `PROMPT:${id}`),
}));

vi.mock('../../../main/utils/remote-git', () => ({
	execGit: vi.fn(),
}));

vi.mock('../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
}));

vi.mock('../../../main/local-models/sources', () => ({
	readLocalModelAssignments: vi.fn(),
}));

vi.mock('../../../main/local-models/endpoint-service', () => ({
	getConfiguredLocalModelEndpoints: vi.fn(() => [{ id: 'ep-1', name: 'Ollama' }]),
}));

import {
	draftPullRequest,
	draftPullRequestRequest,
	parsePullRequestDraftRequest,
} from '../../../main/local-models/git-drafts';
import { GIT_DRAFT_PR_REPLY_SCHEMA } from '../../../shared/gitDrafts';
import { execGit } from '../../../main/utils/remote-git';
import { runLocalTask } from '../../../main/local-models/task-router';
import { readLocalModelAssignments } from '../../../main/local-models/sources';

const CWD = '/repo/worktree';
const ENDPOINT_SOURCE = { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' } as const;
const ASSIGNED = { 'git-drafts': ENDPOINT_SOURCE };

const LOG = 'abc1234 Add backoff\ndef5678 Cap retries\n';
const STAT = ' src/sync.ts | 12 ++++++------\n 1 file changed, 6 insertions(+), 6 deletions(-)\n';

interface GitScript {
	head?: { exitCode: number; stdout?: string };
	/** Refs that resolve to a commit. */
	refs?: string[];
	log?: { exitCode: number; stdout?: string; stderr?: string };
	stat?: { exitCode: number; stdout?: string; stderr?: string };
}

/** Answer each git call by what it asks, and record the argument lists. */
function scriptGit(script: GitScript = {}) {
	const refs = script.refs ?? ['main'];
	vi.mocked(execGit).mockImplementation(async (args: string[]) => {
		const done = (result: { exitCode: number; stdout?: string; stderr?: string }) => ({
			stdout: '',
			stderr: '',
			...result,
		});
		if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
			return done(script.head ?? { exitCode: 0, stdout: 'feat/retry\n' });
		}
		if (args[0] === 'rev-parse') {
			const ref = args[args.length - 1].replace('^{commit}', '');
			return done({ exitCode: refs.includes(ref) ? 0 : 1 });
		}
		if (args[0] === 'log') return done(script.log ?? { exitCode: 0, stdout: LOG });
		if (args[0] === 'diff') return done(script.stat ?? { exitCode: 0, stdout: STAT });
		throw new Error(`unexpected git call: ${args.join(' ')}`);
	});
}

function gitCalls(): string[][] {
	return vi.mocked(execGit).mock.calls.map(([args]) => args);
}

function okVerdict(json: unknown, text = '') {
	return { status: 'ok', text, json, source: ENDPOINT_SOURCE, durationMs: 900 } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readLocalModelAssignments).mockReturnValue(ASSIGNED as never);
	scriptGit();
});

describe('draftPullRequest', () => {
	it('is off by default, without reading the repository or asking a model', async () => {
		vi.mocked(readLocalModelAssignments).mockReturnValue({});

		const result = await draftPullRequest({ cwd: CWD, baseBranch: 'main' });

		expect(result).toMatchObject({ success: false, status: 'off' });
		expect(result.success === false && result.error).toMatch(
			/Git drafts is off.*Settings > Models > System Two/
		);
		expect(execGit).not.toHaveBeenCalled();
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('summarizes the branch against the target and returns the draft', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(
			okVerdict({ title: '"Add retry with backoff."', body: 'Retries.\n\n- Backoff' })
		);

		const result = await draftPullRequest({ cwd: CWD, baseBranch: 'main' });

		expect(result).toEqual({
			success: true,
			title: 'Add retry with backoff',
			body: 'Retries.\n\n- Backoff',
			baseBranch: 'main',
			commitCount: 2,
			truncated: false,
			producedBy: 'qwen3:latest on Ollama',
		});

		// Local reads only: no SSH remote is ever handed to git.
		for (const call of vi.mocked(execGit).mock.calls) {
			expect(call[1]).toBe(CWD);
			expect(call[2]).toBeUndefined();
		}
		const calls = gitCalls();
		expect(calls.find((args) => args[0] === 'log')).toEqual(
			expect.arrayContaining(['--oneline', 'main..HEAD'])
		);
		// Three dots: what the branch changed since it left the target.
		expect(calls.find((args) => args[0] === 'diff')).toEqual(
			expect.arrayContaining(['--stat', 'main...HEAD'])
		);
	});

	it('sends the short prompt as the system turn, the summary as the prompt, and the schema', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ title: 'T', body: 'B' }));

		await draftPullRequest({ cwd: CWD, baseBranch: 'main' });

		const [taskId, input] = vi.mocked(runLocalTask).mock.calls[0];
		expect(taskId).toBe('git-drafts');
		expect(input.system).toBe('PROMPT:git-draft-pr-local');
		expect(input.prompt).toContain('Branch: feat/retry');
		expect(input.prompt).toContain('Target branch: main');
		expect(input.prompt).toContain('abc1234 Add backoff');
		expect(input.prompt).toContain('1 file changed, 6 insertions(+), 6 deletions(-)');
		expect(input.jsonSchema).toBe(GIT_DRAFT_PR_REPLY_SCHEMA);
		expect(input.signal).toBeInstanceOf(AbortSignal);
	});

	it('falls back to origin/<branch> when the target is not a local branch', async () => {
		scriptGit({ refs: ['origin/develop'] });
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ title: 'T', body: 'B' }));

		const result = await draftPullRequest({ cwd: CWD, baseBranch: 'develop' });

		expect(result).toMatchObject({ success: true, baseBranch: 'develop' });
		expect(gitCalls().find((args) => args[0] === 'log')).toContain('origin/develop..HEAD');
	});

	it('defaults the target to main, then master, like the form', async () => {
		scriptGit({ refs: ['master'] });
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ title: 'T', body: 'B' }));

		await expect(draftPullRequest({ cwd: CWD })).resolves.toMatchObject({
			success: true,
			baseBranch: 'master',
		});
	});

	it.each([
		[
			'not a repository',
			{ head: { exitCode: 128 } } as GitScript,
			'main',
			/is not a git repository/,
		],
		['an unknown target branch', { refs: [] } as GitScript, 'nope', /"nope" does not exist/],
		['no default target branch', { refs: [] } as GitScript, undefined, /tried main, master/],
		[
			'a failing git log',
			{ log: { exitCode: 1, stderr: 'fatal: bad revision' } } as GitScript,
			'main',
			/fatal: bad revision/,
		],
		[
			'a failing git diff',
			{ stat: { exitCode: 1, stderr: 'fatal: no merge base' } } as GitScript,
			'main',
			/fatal: no merge base/,
		],
	])('reports %s without asking a model', async (_label, script, baseBranch, message) => {
		scriptGit(script);

		const result = await draftPullRequest({ cwd: CWD, baseBranch });

		expect(result).toMatchObject({ success: false, status: 'git-failed' });
		expect(result.success === false && result.error).toMatch(message);
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('says so when the branch has nothing the target lacks', async () => {
		scriptGit({ log: { exitCode: 0, stdout: '\n' } });

		const result = await draftPullRequest({ cwd: CWD, baseBranch: 'main' });

		expect(result).toMatchObject({ success: false, status: 'no-changes' });
		expect(result.success === false && result.error).toMatch(
			/feat\/retry has no commits that main does not have/
		);
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('fails with the reason when the assigned source is unavailable', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({
			status: 'unavailable',
			source: ENDPOINT_SOURCE,
			reason: 'Ollama is not reachable. Start it.',
			code: 'network',
		});

		await expect(draftPullRequest({ cwd: CWD, baseBranch: 'main' })).resolves.toEqual({
			success: false,
			status: 'unavailable',
			error: 'Ollama is not reachable. Start it.',
		});
	});

	it('reports a timeout as cancelled', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'cancelled', source: ENDPOINT_SOURCE });

		await expect(draftPullRequest({ cwd: CWD, baseBranch: 'main' })).resolves.toMatchObject({
			success: false,
			status: 'cancelled',
		});
	});

	it('reports off when the assignment was switched off mid-request', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'off' });

		await expect(draftPullRequest({ cwd: CWD, baseBranch: 'main' })).resolves.toMatchObject({
			success: false,
			status: 'off',
		});
	});

	it('refuses the Utility Agent: the task has no agent path to keep', async () => {
		vi.mocked(runLocalTask).mockResolvedValue({ status: 'use-utility-agent' });

		const result = await draftPullRequest({ cwd: CWD, baseBranch: 'main' });

		expect(result).toMatchObject({ success: false, status: 'unavailable' });
		expect(result.success === false && result.error).toMatch(/cannot run on the Utility Agent/);
	});

	it('names the model when its reply is not a usable draft', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict(undefined, 'Sure! Here is a title'));

		await expect(draftPullRequest({ cwd: CWD, baseBranch: 'main' })).resolves.toEqual({
			success: false,
			status: 'unusable',
			error: 'The model did not return a usable title. Try again, or assign a larger model.',
			producedBy: 'qwen3:latest on Ollama',
		});
	});

	it('lets an unclassified engine failure reach the caller', async () => {
		vi.mocked(runLocalTask).mockRejectedValue(new Error('engine exploded'));

		await expect(draftPullRequest({ cwd: CWD, baseBranch: 'main' })).rejects.toThrow(
			'engine exploded'
		);
	});
});

describe('parsePullRequestDraftRequest', () => {
	it('accepts an absolute path with or without a target branch', () => {
		expect(parsePullRequestDraftRequest({ cwd: CWD })).toEqual({ cwd: CWD });
		expect(parsePullRequestDraftRequest({ cwd: CWD, baseBranch: 'release/1.2' })).toEqual({
			cwd: CWD,
			baseBranch: 'release/1.2',
		});
		expect(parsePullRequestDraftRequest({ cwd: CWD, baseBranch: '' })).toEqual({ cwd: CWD });
	});

	it.each([
		['nothing', undefined, /needs a repository path/],
		['an empty path', { cwd: '  ' }, /needs a repository path/],
		['a relative path', { cwd: 'repo' }, /must be absolute/],
		['a branch that reads as an option', { cwd: CWD, baseBranch: '--output=x' }, /valid branch/],
		['a branch with a space', { cwd: CWD, baseBranch: 'main HEAD' }, /valid branch/],
		['a revision range', { cwd: CWD, baseBranch: 'a..b' }, /valid branch/],
		['a non-string branch', { cwd: CWD, baseBranch: 7 }, /valid branch/],
	])('refuses %s', (_label, value, message) => {
		expect(() => parsePullRequestDraftRequest(value)).toThrow(message);
	});
});

describe('draftPullRequestRequest', () => {
	it('checks the request before anything runs', async () => {
		await expect(draftPullRequestRequest({ cwd: CWD, baseBranch: '-x' })).rejects.toThrow(
			/valid branch/
		);
		expect(execGit).not.toHaveBeenCalled();
		expect(runLocalTask).not.toHaveBeenCalled();
	});

	it('runs a valid request through the same draft', async () => {
		vi.mocked(runLocalTask).mockResolvedValue(okVerdict({ title: 'T', body: 'B' }));

		await expect(draftPullRequestRequest({ cwd: CWD, baseBranch: 'main' })).resolves.toMatchObject({
			success: true,
			title: 'T',
		});
	});
});
