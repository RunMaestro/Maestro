/**
 * Tests for src/main/agents/provider-account-dirs.ts
 *
 * Covers the attribution failures this module exists to prevent:
 *   - two Codex accounts are two account dirs, not one merged read
 *   - an account dir outside $HOME is still found, because a configured agent
 *     names it (the sibling scan never could)
 *   - a symlinked shared transcript pool is read once, not once per account
 *   - an unrelated `<subdir>-*` folder with no sessions subtree is not an account
 *   - an SSH-remote agent's dir is NOT adopted: it names a path on that host
 *   - a provider with no account-selecting env var reports no account dirs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

// The module reads the sessions / agent-configs stores when the caller does not
// inject them. Every test here injects, so the stores only need to not explode
// at import time.
vi.mock('../../../main/stores/instances', () => ({
	isInitialized: () => false,
}));

vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => {
		throw new Error('stores must not be read when sessions are injected');
	},
	getAgentConfigsStore: () => {
		throw new Error('stores must not be read when env vars are injected');
	},
}));

import { getProviderAccountDirs } from '../../../main/agents/provider-account-dirs';

let homeDir: string;
let outsideHome: string;

/** Create `<home>/<name>/<sessionsSubdir>` and return the account dir. */
function makeAccountDir(root: string, name: string, sessionsSubdir: string): string {
	const dir = path.join(root, name);
	fs.mkdirSync(path.join(dir, sessionsSubdir), { recursive: true });
	return dir;
}

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-account-dirs-'));
	fs.mkdirSync(path.join(tmpRoot, 'home'), { recursive: true });
	fs.mkdirSync(path.join(tmpRoot, 'elsewhere'), { recursive: true });
	// realpath so macOS's /var -> /private/var symlink does not make every
	// expectation fail on a path the module correctly resolved.
	homeDir = fs.realpathSync(path.join(tmpRoot, 'home'));
	outsideHome = fs.realpathSync(path.join(tmpRoot, 'elsewhere'));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('getProviderAccountDirs', () => {
	it('keeps two Codex accounts apart instead of merging them', async () => {
		const defaultHome = makeAccountDir(homeDir, '.codex', 'sessions');
		const workHome = makeAccountDir(homeDir, '.codex-work', 'sessions');

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs.sort()).toEqual([defaultHome, workHome].sort());
	});

	it("finds an account dir outside $HOME from an agent's own customEnvVars", async () => {
		makeAccountDir(homeDir, '.codex', 'sessions');
		const external = makeAccountDir(outsideHome, 'codex-acc-1', 'sessions');

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [{ toolType: 'codex', customEnvVars: { CODEX_HOME: external } }],
			agentLevelEnvVars: {},
		});

		expect(dirs).toContain(external);
	});

	it('falls back to the provider-level env when the agent sets none', async () => {
		makeAccountDir(homeDir, '.codex', 'sessions');
		const external = makeAccountDir(outsideHome, 'codex-provider', 'sessions');

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [{ toolType: 'codex' }],
			agentLevelEnvVars: { CODEX_HOME: external },
		});

		expect(dirs).toContain(external);
	});

	it("does not adopt an SSH-remote agent's dir, which names a path on that host", async () => {
		makeAccountDir(homeDir, '.claude', 'projects');
		const remoteOnlyPath = path.join(outsideHome, 'claude-on-the-remote');

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [
				{
					toolType: 'claude-code',
					customEnvVars: { CLAUDE_CONFIG_DIR: remoteOnlyPath },
					sessionSshRemoteConfig: { enabled: true },
				},
			],
			agentLevelEnvVars: {},
		});

		expect(dirs).not.toContain(remoteOnlyPath);
	});

	it('reads a symlinked shared transcript pool exactly once', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		// The common multi-account setup: separate credentials, one shared pool.
		const sharedHome = path.join(homeDir, '.claude-work');
		fs.mkdirSync(sharedHome, { recursive: true });
		fs.symlinkSync(path.join(defaultHome, 'projects'), path.join(sharedHome, 'projects'), 'dir');

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([defaultHome]);
	});

	it('reads a shared pool once while still reading a genuinely separate account', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		const ownPool = makeAccountDir(homeDir, '.claude-work', 'projects');
		const sharedHome = path.join(homeDir, '.claude-gmail');
		fs.mkdirSync(sharedHome, { recursive: true });
		fs.symlinkSync(path.join(defaultHome, 'projects'), path.join(sharedHome, 'projects'), 'dir');

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs.sort()).toEqual([defaultHome, ownPool].sort());
	});

	it('keeps an account whose sessions tree does not exist yet', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		const fresh = path.join(outsideHome, 'claude-fresh');
		fs.mkdirSync(fresh, { recursive: true });

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [{ toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: fresh } }],
			agentLevelEnvVars: {},
		});

		// A brand-new account with no transcripts yet still appears rather than
		// silently collapsing into another account.
		expect(dirs.sort()).toEqual([defaultHome, fresh].sort());
	});

	it('ignores a lookalike folder with no sessions subtree', async () => {
		const defaultHome = makeAccountDir(homeDir, '.codex', 'sessions');
		fs.mkdirSync(path.join(homeDir, '.codex-notes'), { recursive: true });

		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([defaultHome]);
	});

	it('ignores a backup copy of an account dir', async () => {
		const defaultHome = makeAccountDir(homeDir, '.claude', 'projects');
		makeAccountDir(homeDir, '.claude-backup', 'projects');

		const dirs = await getProviderAccountDirs('claude-code', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([defaultHome]);
	});

	it("honours Maestro's own environment for a user who exports the var", async () => {
		makeAccountDir(homeDir, '.copilot', 'session-state');
		const exported = makeAccountDir(outsideHome, 'copilot-exported', 'session-state');

		const dirs = await getProviderAccountDirs('copilot-cli', {
			homeDir,
			env: { COPILOT_HOME: exported },
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toContain(exported);
	});

	it('reports no account dirs for a provider with no account-selecting env var', async () => {
		await expect(
			getProviderAccountDirs('opencode', { homeDir, env: {}, sessions: [], agentLevelEnvVars: {} })
		).resolves.toEqual([]);
		await expect(
			getProviderAccountDirs('factory-droid', {
				homeDir,
				env: {},
				sessions: [],
				agentLevelEnvVars: {},
			})
		).resolves.toEqual([]);
	});

	it('still reports the default account when nothing exists on disk yet', async () => {
		const dirs = await getProviderAccountDirs('codex', {
			homeDir,
			env: {},
			sessions: [],
			agentLevelEnvVars: {},
		});

		expect(dirs).toEqual([path.join(homeDir, '.codex')]);
	});
});
