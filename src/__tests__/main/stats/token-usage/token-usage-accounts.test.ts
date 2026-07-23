/**
 * Tests for Claude multi-account discovery in the Cost & Tokens accessor.
 *
 * The load-bearing case: a very common multi-account setup symlinks
 * `~/.claude-<name>/projects` back at `~/.claude/projects`, so several config
 * dirs share ONE transcript pool (only the credentials differ). Reading each dir
 * blindly would count the same sessions once per account and multiply reported
 * tokens. Discovery must collapse on the resolved real path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => path.join(os.tmpdir(), 'maestro-token-usage-accounts-test')),
	},
}));

// Discovery of candidate config dirs (the raw ~/.claude* scan).
const discoverClaudeConfigDirs = vi.fn<() => Promise<string[]>>();
vi.mock('../../../../main/agents/claude-usage-startup', () => ({
	discoverClaudeConfigDirs: () => discoverClaudeConfigDirs(),
}));

// realpath resolves the symlinked projects/ trees.
const realpath = vi.fn<(p: string) => Promise<string>>();
vi.mock('fs/promises', () => ({
	realpath: (p: string) => realpath(p),
	readFile: vi.fn(),
	writeFile: vi.fn(),
}));

import { _internal } from '../../../../main/stats/token-usage/token-usage-accessor';

const { discoverClaudeAccounts } = _internal;

// Build fixture paths through path.resolve/path.join so they match what the
// accessor produces (`path.resolve(dir)`) on every platform. On POSIX these
// stay `/home/u/.claude`; on Windows path.resolve rewrites a drive-less
// absolute path to `<drive>:\home\u\.claude`, which is exactly what the
// accessor normalizes its input to - so asserting native paths keeps the test
// green on the Windows CI leg instead of hard-coding POSIX separators.
const claude = path.resolve('/home/u/.claude');
const claudeGmail = path.resolve('/home/u/.claude-gmail');
const claudeSmash = path.resolve('/home/u/.claude-smash');
const claudeWork = path.resolve('/home/u/.claude-work');
const claudeFresh = path.resolve('/home/u/.claude-fresh');
const projects = (dir: string) => path.join(dir, 'projects');

/** Resolve each dir's projects/ to itself (i.e. no symlinks - genuinely separate). */
function realpathIdentity() {
	realpath.mockImplementation(async (p: string) => p);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('discoverClaudeAccounts', () => {
	it('collapses config dirs that symlink to a shared projects tree', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([claude, claudeGmail, claudeSmash]);
		// All three point their projects/ at the same real pool.
		realpath.mockResolvedValue(projects(claude));

		const accounts = await discoverClaudeAccounts();

		// One shared pool -> read exactly once, not three times.
		expect(accounts).toEqual([claude]);
	});

	it('keeps genuinely separate accounts distinct', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([claude, claudeWork]);
		realpathIdentity();

		const accounts = await discoverClaudeAccounts();

		expect(accounts).toHaveLength(2);
		expect(accounts).toContain(claude);
		expect(accounts).toContain(claudeWork);
	});

	it('reads a shared pool once while still reading a separate account', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([
			claude,
			claudeGmail, // symlinked to the shared pool
			claudeWork, // its own pool
		]);
		realpath.mockImplementation(async (p: string) =>
			p.startsWith(claudeWork) ? projects(claudeWork) : projects(claude)
		);

		const accounts = await discoverClaudeAccounts();

		expect(accounts).toHaveLength(2);
		expect(accounts).toContain(claude);
		expect(accounts).toContain(claudeWork);
		expect(accounts).not.toContain(claudeGmail);
	});

	it('keeps an account whose projects tree does not exist yet', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([claude, claudeFresh]);
		realpath.mockImplementation(async (p: string) => {
			if (p.startsWith(claudeFresh)) throw new Error('ENOENT');
			return projects(claude);
		});

		const accounts = await discoverClaudeAccounts();

		// A brand-new account with no transcripts yet still appears rather than
		// silently collapsing into another account.
		expect(accounts).toContain(claudeFresh);
		expect(accounts).toContain(claude);
	});

	it('falls back to the default ~/.claude when discovery finds nothing', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([]);

		const accounts = await discoverClaudeAccounts();

		expect(accounts).toEqual([path.join(os.homedir(), '.claude')]);
	});

	it('falls back to the default account when discovery throws', async () => {
		discoverClaudeConfigDirs.mockRejectedValue(new Error('permission denied'));

		const accounts = await discoverClaudeAccounts();

		expect(accounts).toEqual([path.join(os.homedir(), '.claude')]);
	});
});
