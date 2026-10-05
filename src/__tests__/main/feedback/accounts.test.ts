import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Set<string>();
const settings = new Map<string, unknown>();
let sessions: unknown[] = [];
let agentConfigs: Record<string, Record<string, unknown>> = {};

vi.mock('os', async (importOriginal) => {
	const actual = await importOriginal<typeof import('os')>();
	return {
		...actual,
		default: { ...actual, homedir: () => '/home/me' },
		homedir: () => '/home/me',
	};
});

vi.mock('fs/promises', () => ({
	default: {
		// path.join speaks backslashes on Windows; the fixtures are POSIX.
		access: vi.fn(async (p: string) => {
			if (!files.has(p.replace(/\\/g, '/'))) {
				throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			}
		}),
	},
}));

vi.mock('../../../main/agents/claude-account-identity', () => ({
	readClaudeAccountIdentity: vi.fn(async (dir: string) =>
		files.has(`${dir}/.claude.json`) ? { email: `me@${dir.split('/').pop()}` } : null
	),
}));

vi.mock('../../../main/stores/instances', () => ({ isInitialized: () => true }));

vi.mock('../../../main/stores/getters', () => ({
	getSessionsStore: () => ({ get: () => sessions }),
	getAgentConfigsStore: () => ({ get: () => agentConfigs }),
	getSettingsStore: () => ({
		get: (key: string) => settings.get(key),
		set: (key: string, value: unknown) => settings.set(key, value),
	}),
	getSshRemoteById: (id: string) => ({ id, name: `remote-${id}` }),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { listFeedbackAccounts, rememberFeedbackAccount } from '../../../main/feedback/accounts';

const detector = (installed: string[]) =>
	({
		detectAgents: async () => installed.map((id) => ({ id, available: true })),
	}) as never;

describe('listFeedbackAccounts', () => {
	beforeEach(() => {
		files.clear();
		settings.clear();
		sessions = [];
		agentConfigs = {};
	});

	it("picks the agent's signed-in account over the default login nobody signed into", async () => {
		// Neema's setup: every agent runs on its own config dir; ~/.claude is empty.
		sessions = [
			{
				id: 's1',
				name: 'Work',
				toolType: 'claude-code',
				cwd: '/p',
				customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
			},
		];
		files.add('/home/me/.claude-work/.claude.json');

		const { accounts } = await listFeedbackAccounts(() => detector(['claude-code']));

		expect(accounts[0]).toMatchObject({
			key: 'claude-code::/home/me/.claude-work',
			status: 'ready',
			statusDetail: 'Signed in as me@.claude-work',
			env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
		});
		const fallback = accounts.find((a) => a.key === 'claude-code::/home/me/.claude')!;
		expect(fallback.status).toBe('not-logged-in');
		// Codex and OpenCode are not installed, so they are listed but never tried.
		expect(accounts.find((a) => a.toolType === 'codex')!.status).toBe('not-installed');
	});

	it('reads the default Claude login from ~/.claude.json, not ~/.claude/.claude.json', async () => {
		files.add('/home/me/.claude.json');
		const { accounts } = await listFeedbackAccounts(() => detector(['claude-code']));
		expect(accounts[0]).toMatchObject({ key: 'claude-code::/home/me/.claude', status: 'ready' });
	});

	it('treats a Codex home with auth.json, or an API key, as signed in', async () => {
		sessions = [
			{
				id: 'a',
				name: 'Keyed',
				toolType: 'codex',
				cwd: '/p',
				customEnvVars: { OPENAI_API_KEY: 'sk-1234wxyz' },
			},
		];
		files.add('/home/me/.codex/auth.json');
		const { accounts } = await listFeedbackAccounts(() => detector(['codex']));
		const keyed = accounts.find((a) => a.agentNames.includes('Keyed'))!;
		expect(keyed.status).toBe('ready');
		expect(accounts.find((a) => a.key === 'codex::/home/me/.codex')!.status).toBe('ready');
	});

	it("checks an agent's own binary instead of detection", async () => {
		sessions = [
			{ id: 'c', name: 'Custom', toolType: 'claude-code', cwd: '/p', customPath: '/opt/claude' },
		];
		files.add('/opt/claude');
		files.add('/home/me/.claude.json');
		const { accounts } = await listFeedbackAccounts(() => detector([]));
		expect(accounts[0]).toMatchObject({ customPath: '/opt/claude', status: 'ready' });
	});

	it('tries the remembered account first and forgets it when it is gone', async () => {
		files.add('/home/me/.claude.json');
		files.add('/home/me/.codex/auth.json');
		rememberFeedbackAccount('codex::/home/me/.codex');
		const remembered = await listFeedbackAccounts(() => detector(['claude-code', 'codex']));
		expect(remembered.lastWorkingKey).toBe('codex::/home/me/.codex');
		expect(remembered.accounts[0].key).toBe('codex::/home/me/.codex');

		rememberFeedbackAccount('claude-code::/nowhere');
		const stale = await listFeedbackAccounts(() => detector(['claude-code', 'codex']));
		expect(stale.lastWorkingKey).toBeNull();
	});
});
