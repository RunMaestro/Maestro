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

/** Resolve each dir's projects/ to itself (i.e. no symlinks - genuinely separate). */
function realpathIdentity() {
	realpath.mockImplementation(async (p: string) => p);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('discoverClaudeAccounts', () => {
	it('collapses config dirs that symlink to a shared projects tree', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([
			'/home/u/.claude',
			'/home/u/.claude-gmail',
			'/home/u/.claude-smash',
		]);
		// All three point their projects/ at the same real pool.
		realpath.mockResolvedValue('/home/u/.claude/projects');

		const accounts = await discoverClaudeAccounts();

		// One shared pool -> read exactly once, not three times.
		expect(accounts).toEqual(['/home/u/.claude']);
	});

	it('keeps genuinely separate accounts distinct', async () => {
		discoverClaudeConfigDirs.mockResolvedValue(['/home/u/.claude', '/home/u/.claude-work']);
		realpathIdentity();

		const accounts = await discoverClaudeAccounts();

		expect(accounts).toHaveLength(2);
		expect(accounts).toContain('/home/u/.claude');
		expect(accounts).toContain('/home/u/.claude-work');
	});

	it('reads a shared pool once while still reading a separate account', async () => {
		discoverClaudeConfigDirs.mockResolvedValue([
			'/home/u/.claude',
			'/home/u/.claude-gmail', // symlinked to the shared pool
			'/home/u/.claude-work', // its own pool
		]);
		realpath.mockImplementation(async (p: string) =>
			p.startsWith('/home/u/.claude-work')
				? '/home/u/.claude-work/projects'
				: '/home/u/.claude/projects'
		);

		const accounts = await discoverClaudeAccounts();

		expect(accounts).toHaveLength(2);
		expect(accounts).toContain('/home/u/.claude');
		expect(accounts).toContain('/home/u/.claude-work');
		expect(accounts).not.toContain('/home/u/.claude-gmail');
	});

	it('keeps an account whose projects tree does not exist yet', async () => {
		discoverClaudeConfigDirs.mockResolvedValue(['/home/u/.claude', '/home/u/.claude-fresh']);
		realpath.mockImplementation(async (p: string) => {
			if (p.startsWith('/home/u/.claude-fresh')) throw new Error('ENOENT');
			return '/home/u/.claude/projects';
		});

		const accounts = await discoverClaudeAccounts();

		// A brand-new account with no transcripts yet still appears rather than
		// silently collapsing into another account.
		expect(accounts).toContain('/home/u/.claude-fresh');
		expect(accounts).toContain('/home/u/.claude');
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
