/**
 * Tests for discoverGithubProject — structured error codes (#447).
 *
 * We mock:
 *   - `../utils/execFile` (execFileNoThrow) — controls all subprocess results
 *   - `../utils/ssh-command-builder` (buildSshCommand) — stubbed for SSH tests
 *
 * NOTE: fs.existsSync is no longer used by the discovery function — git repo
 * detection was switched to `git -C <path> rev-parse --is-inside-work-tree`
 * so it works transparently over SSH without local filesystem access.
 *
 * All git calls now use `git -C <path> <subcommand>` so matchers must look at
 * args[0] === '-C' and args[2] for the subcommand (e.g. 'rev-parse', 'remote').
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock execFileNoThrow ─────────────────────────────────────────────────────
vi.mock('../../utils/execFile', () => ({
	execFileNoThrow: vi.fn(),
}));

// ── Mock buildSshCommand (so SSH tests don't need a real SSH binary) ─────────
vi.mock('../../utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn().mockResolvedValue({ command: 'ssh', args: ['-stub'] }),
}));

import { execFileNoThrow } from '../../utils/execFile';
import { discoverGithubProject } from '../github-project-discovery';
import type { ExecResult } from '../../utils/execFile';

// Typed helpers
const mockExec = execFileNoThrow as ReturnType<typeof vi.fn>;

const ok = (stdout: string, stderr = ''): ExecResult => ({ stdout, stderr, exitCode: 0 });
const fail = (stderr: string, exitCode: number | string = 1): ExecResult => ({
	stdout: '',
	stderr,
	exitCode,
});

// A minimal valid project list JSON
const projectListJson = JSON.stringify({
	projects: [{ id: 'pid-1', number: 42, title: 'my-repo AI Project' }],
});

// A valid new-project JSON
const newProjectJson = JSON.stringify({ id: 'pid-new', number: 99, title: 'my-repo AI Project' });

/**
 * Helper: does this git call match the given subcommand?
 * All git calls now use `-C <path> <subcommand> ...` so args[0] === '-C'.
 */
function isGitCmd(cmd: string, args: string[], subcommand: string): boolean {
	return cmd === 'git' && args[0] === '-C' && args[2] === subcommand;
}

/** Set up default happy-path mocks. Tests override as needed. */
function setupHappyPath() {
	mockExec.mockImplementation(async (cmd: string, args: string[]) => {
		// gh --version
		if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
		// gh auth status
		if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
		// git -C <path> rev-parse --is-inside-work-tree
		if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
		// git -C <path> remote get-url origin
		if (isGitCmd(cmd, args, 'remote')) {
			return ok('https://github.com/owner/my-repo.git');
		}
		// gh project list
		if (cmd === 'gh' && args[0] === 'project' && args[1] === 'list') {
			return ok(projectListJson);
		}
		return ok('{}');
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ── gh CLI missing ───────────────────────────────────────────────────────────

describe('GH_CLI_MISSING', () => {
	it('returns GH_CLI_MISSING when gh is not on PATH (ENOENT)', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return fail('not found', 'ENOENT');
			return ok('');
		});

		const result = await discoverGithubProject('/some/project');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('GH_CLI_MISSING');
			expect(result.error.message).toContain('https://cli.github.com/');
		}
	});

	it('returns GH_CLI_MISSING when gh is not accessible (EACCES)', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return fail('permission denied', 'EACCES');
			return ok('');
		});

		const result = await discoverGithubProject('/some/project');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('GH_CLI_MISSING');
	});
});

// ── Not a git repo ───────────────────────────────────────────────────────────

describe('NOT_A_GIT_REPO', () => {
	it('returns NOT_A_GIT_REPO when git rev-parse fails', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			// git rev-parse returns non-zero for non-repos
			if (isGitCmd(cmd, args, 'rev-parse')) return fail('not a git repository', 128);
			return ok('');
		});

		const result = await discoverGithubProject('/not/a/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('NOT_A_GIT_REPO');
			expect(result.error.message).toContain('git repository');
		}
	});
});

// ── No origin remote ────────────────────────────────────────────────────────

describe('NO_ORIGIN_REMOTE', () => {
	it('returns NO_ORIGIN_REMOTE when git remote get-url origin fails', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return fail('fatal: No such remote', 128);
			}
			return ok('');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('NO_ORIGIN_REMOTE');
			expect(result.error.message).toContain('origin');
		}
	});

	it('returns NO_ORIGIN_REMOTE when git remote returns empty stdout', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) return ok('');
			return ok('');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('NO_ORIGIN_REMOTE');
	});
});

// ── Not GitHub ───────────────────────────────────────────────────────────────

describe('NOT_GITHUB', () => {
	it('returns NOT_GITHUB for a GitLab SSH remote', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return ok('git@gitlab.com:owner/repo.git');
			}
			return ok('');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('NOT_GITHUB');
			expect(result.error.message).toContain('github.com');
		}
	});

	it('returns NOT_GITHUB for a Bitbucket HTTPS remote', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return ok('https://bitbucket.org/owner/repo.git');
			}
			return ok('');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe('NOT_GITHUB');
	});
});

// ── GH_AUTH_REQUIRED ────────────────────────────────────────────────────────

describe('GH_AUTH_REQUIRED', () => {
	it('returns GH_AUTH_REQUIRED when gh auth status fails', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return fail('not logged in', 1);
			return ok('');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('GH_AUTH_REQUIRED');
			expect(result.error.message).toContain('gh auth login');
		}
	});
});

// ── Empty project list — creates or surfaces NO_PROJECT_AND_CANNOT_CREATE ───

describe('empty project list', () => {
	it('creates a new project when the list is empty and succeeds', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return ok('https://github.com/owner/my-repo.git');
			}
			if (cmd === 'gh' && args[0] === 'project' && args[1] === 'list') {
				return ok(JSON.stringify({ projects: [] }));
			}
			if (cmd === 'gh' && args[0] === 'project' && args[1] === 'create') {
				return ok(newProjectJson);
			}
			return ok('{}');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mapping.projectNumber).toBe(99);
		}
	});

	it('returns NO_PROJECT_AND_CANNOT_CREATE when list is empty and create fails', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return ok('https://github.com/owner/my-repo.git');
			}
			if (cmd === 'gh' && args[0] === 'project' && args[1] === 'list') {
				return ok(JSON.stringify({ projects: [] }));
			}
			if (cmd === 'gh' && args[0] === 'project' && args[1] === 'create') {
				return fail('Must have push access to create a project', 1);
			}
			return ok('{}');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('NO_PROJECT_AND_CANNOT_CREATE');
			expect(result.error.message).toContain('permissions');
		}
	});
});

// ── MULTIPLE_MATCHES ─────────────────────────────────────────────────────────

describe('MULTIPLE_MATCHES', () => {
	it('returns MULTIPLE_MATCHES with all candidates when >1 project title matches', async () => {
		const multipleProjects = JSON.stringify({
			projects: [
				{ id: 'pid-1', number: 10, title: 'my-repo Sprint Board' },
				{ id: 'pid-2', number: 11, title: 'my-repo Backlog' },
			],
		});
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return ok('https://github.com/owner/my-repo.git');
			}
			if (cmd === 'gh' && args[0] === 'project' && args[1] === 'list') {
				return ok(multipleProjects);
			}
			return ok('{}');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe('MULTIPLE_MATCHES');
			expect(result.error.candidates).toHaveLength(2);
			expect(result.error.candidates?.[0].number).toBe(10);
			expect(result.error.candidates?.[1].number).toBe(11);
		}
	});
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('happy path', () => {
	it('returns the matching project mapping on success', async () => {
		setupHappyPath();

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mapping.owner).toBe('owner');
			expect(result.mapping.repo).toBe('my-repo');
			expect(result.mapping.projectNumber).toBe(42);
		}
	});

	it('handles git@github.com SSH remote correctly', async () => {
		mockExec.mockImplementation(async (cmd: string, args: string[]) => {
			if (cmd === 'gh' && args[0] === '--version') return ok('gh version 2.40.0');
			if (cmd === 'gh' && args[0] === 'auth') return ok('Logged in');
			if (isGitCmd(cmd, args, 'rev-parse')) return ok('true');
			if (isGitCmd(cmd, args, 'remote')) {
				return ok('git@github.com:acme/my-repo.git');
			}
			if (cmd === 'gh' && args[0] === 'project' && args[1] === 'list') {
				return ok(
					JSON.stringify({ projects: [{ id: 'pid-3', number: 5, title: 'my-repo Board' }] })
				);
			}
			return ok('{}');
		});

		const result = await discoverGithubProject('/some/repo');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.mapping.owner).toBe('acme');
			expect(result.mapping.repo).toBe('my-repo');
		}
	});
});
