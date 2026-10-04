/**
 * Tests for shared/providerAccountSwitch
 *
 * Covers:
 *   - the blocker refuses every credential kind a config-dir switch cannot
 *     change (API key, gateway, cloud provider), plus SSH agents and providers
 *     with no account split
 *   - accounts are labeled by email, ranked current / usable / spent / signed
 *     out, and a window whose reset has passed no longer counts as spent
 *   - the env patch keeps inherited provider vars, names a non-default dir, and
 *     REMOVES the var for the default dir (or blanks it over a global value)
 */

import { describe, it, expect } from 'vitest';
import {
	accountSwitchBlocker,
	accountSwitchEnv,
	buildSwitchableAccounts,
	claudeSnapshotWindows,
	codexSnapshotWindows,
	recommendedAccount,
} from '../../shared/providerAccountSwitch';

const HOME = '/Users/me';
const NOW = Date.parse('2026-10-03T12:00:00Z');
const LATER = '2026-10-03T15:00:00Z';
const EARLIER = '2026-10-03T11:00:00Z';

describe('accountSwitchBlocker', () => {
	const base = { toolType: 'claude-code', agentName: 'Builder', remote: false };

	it('allows an OAuth login', () => {
		expect(accountSwitchBlocker({ ...base, env: {} })).toBeNull();
		expect(accountSwitchBlocker({ ...base, toolType: 'codex', env: {} })).toBeNull();
	});

	it('refuses an API key, a gateway, and a cloud provider', () => {
		expect(accountSwitchBlocker({ ...base, env: { ANTHROPIC_API_KEY: 'sk-1' } })).toMatch(
			/ANTHROPIC_API_KEY/
		);
		expect(
			accountSwitchBlocker({ ...base, env: { ANTHROPIC_BASE_URL: 'https://gw.example.com' } })
		).toMatch(/gw\.example\.com/);
		expect(accountSwitchBlocker({ ...base, env: { CLAUDE_CODE_USE_BEDROCK: '1' } })).toMatch(
			/AWS Bedrock/
		);
		expect(
			accountSwitchBlocker({ ...base, toolType: 'codex', env: { OPENAI_API_KEY: 'sk-2' } })
		).toMatch(/OPENAI_API_KEY/);
	});

	it('refuses a whitespace-only key as nothing, not as a credential', () => {
		expect(accountSwitchBlocker({ ...base, env: { ANTHROPIC_API_KEY: '  ' } })).toBeNull();
	});

	it('refuses SSH agents and providers with a single credential store', () => {
		expect(accountSwitchBlocker({ ...base, env: {}, remote: true })).toMatch(/SSH/);
		expect(accountSwitchBlocker({ ...base, toolType: 'opencode', env: {} })).toMatch(
			/single credential store/
		);
	});
});

describe('buildSwitchableAccounts', () => {
	const identities = [
		{ accountKey: `${HOME}/.claude`, email: 'me@home.com', signedIn: true },
		{ accountKey: `${HOME}/.claude-work/`, email: 'me@work.com', signedIn: true },
		{ accountKey: `${HOME}/.claude-spare`, signedIn: true },
		{ accountKey: `${HOME}/.claude-empty`, signedIn: false },
	];

	it('labels by email, falls back to the dir name, and ranks current first', () => {
		const accounts = buildSwitchableAccounts({
			toolType: 'claude-code',
			identities,
			quotaByAccountKey: {
				[`${HOME}/.claude`]: [{ label: 'Session', percent: 100, resetsAt: LATER }],
				[`${HOME}/.claude-work`]: [{ label: 'Session', percent: 60 }],
				[`${HOME}/.claude-spare`]: [{ label: 'Session', percent: 10 }],
			},
			currentAccountKey: `${HOME}/.claude-work`,
			now: NOW,
		});
		expect(accounts.map((a) => a.label)).toEqual(['me@work.com', 'spare', 'me@home.com', 'empty']);
		expect(accounts[0].isCurrent).toBe(true);
		expect(accounts[0].dirLabel).toBe('~/.claude-work');
		expect(accounts[2]).toMatchObject({ exhausted: true, reopensAt: LATER });
		expect(recommendedAccount(accounts)?.label).toBe('spare');
	});

	it('stops treating a window as spent once its reset has passed', () => {
		const accounts = buildSwitchableAccounts({
			toolType: 'claude-code',
			identities: identities.slice(0, 1),
			quotaByAccountKey: {
				[`${HOME}/.claude`]: [{ label: 'Session', percent: 100, resetsAt: EARLIER }],
			},
			currentAccountKey: null,
			now: NOW,
		});
		expect(accounts[0].exhausted).toBe(false);
		expect(recommendedAccount(accounts)?.label).toBe('me@home.com');
	});

	it('never recommends a signed-out or spent account', () => {
		const accounts = buildSwitchableAccounts({
			toolType: 'claude-code',
			identities: [identities[0], identities[3]],
			quotaByAccountKey: {
				[`${HOME}/.claude`]: [{ label: 'Weekly', percent: 100, resetsAt: LATER }],
			},
			currentAccountKey: null,
			now: NOW,
		});
		expect(recommendedAccount(accounts)).toBeUndefined();
	});

	it('returns nothing for a provider with no accounts', () => {
		expect(
			buildSwitchableAccounts({
				toolType: 'opencode',
				identities,
				quotaByAccountKey: {},
				currentAccountKey: null,
				now: NOW,
			})
		).toEqual([]);
	});
});

describe('accountSwitchEnv', () => {
	const base = {
		toolType: 'claude-code',
		globalEnv: {},
		homeDir: HOME,
	};

	it('copies the inherited provider vars when the agent had none of its own', () => {
		expect(
			accountSwitchEnv({
				...base,
				sessionEnv: undefined,
				providerEnv: { FOO: '1', CLAUDE_CONFIG_DIR: `${HOME}/.claude-a` },
				targetAccountKey: `${HOME}/.claude-b/`,
			})
		).toEqual({ FOO: '1', CLAUDE_CONFIG_DIR: `${HOME}/.claude-b` });
	});

	it("keeps the agent's own vars and does not mix in the provider set", () => {
		expect(
			accountSwitchEnv({
				...base,
				sessionEnv: { BAR: '2' },
				providerEnv: { FOO: '1' },
				targetAccountKey: `${HOME}/.claude-b`,
			})
		).toEqual({ BAR: '2', CLAUDE_CONFIG_DIR: `${HOME}/.claude-b` });
	});

	it('removes the var to select the default account', () => {
		expect(
			accountSwitchEnv({
				...base,
				sessionEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-b`, BAR: '2' },
				providerEnv: undefined,
				targetAccountKey: `${HOME}/.claude`,
			})
		).toEqual({ BAR: '2' });
	});

	it('blanks the var over a global value to select the default account', () => {
		expect(
			accountSwitchEnv({
				...base,
				globalEnv: { CLAUDE_CONFIG_DIR: `${HOME}/.claude-b` },
				sessionEnv: undefined,
				providerEnv: undefined,
				targetAccountKey: `${HOME}/.claude`,
			})
		).toEqual({ CLAUDE_CONFIG_DIR: '' });
	});

	it('uses CODEX_HOME for codex', () => {
		expect(
			accountSwitchEnv({
				...base,
				toolType: 'codex',
				sessionEnv: undefined,
				providerEnv: undefined,
				targetAccountKey: `${HOME}/.codex-work`,
			})
		).toEqual({ CODEX_HOME: `${HOME}/.codex-work` });
	});
});

describe('snapshot windows', () => {
	it('reads every Claude window and none from an unauthenticated sample', () => {
		const snapshot = {
			session: { percent: 10, resetsAt: LATER },
			weekAllModels: { percent: 20 },
			weekSonnetOnly: { percent: 30, label: 'Fable' },
		};
		expect(claudeSnapshotWindows(snapshot).map((w) => w.label)).toEqual([
			'Session',
			'Weekly',
			'Weekly Fable',
		]);
		expect(claudeSnapshotWindows({ ...snapshot, authState: 'unauthenticated' })).toEqual([]);
	});

	it('reads Codex windows and sublimits only from an authenticated sample', () => {
		const snapshot = {
			authState: 'authenticated',
			session: { percent: 5, resetsAt: LATER },
			weekly: { percent: 50, resetsAt: LATER },
			additionalLimits: [{ name: 'GPT-5 Pro', percent: 100, resetsAt: LATER }],
		};
		expect(codexSnapshotWindows(snapshot).map((w) => w.label)).toEqual([
			'Session',
			'Weekly',
			'GPT-5 Pro',
		]);
		expect(codexSnapshotWindows({ ...snapshot, authState: 'missing_auth' })).toEqual([]);
	});
});
