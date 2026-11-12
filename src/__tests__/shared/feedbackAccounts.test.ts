import { describe, expect, it } from 'vitest';

import {
	buildFeedbackAccountCandidates,
	isFeedbackAccountUsable,
	orderFeedbackAccounts,
	type FeedbackAccount,
	type FeedbackAccountCandidate,
} from '../../shared/feedbackAccounts';

const HOME = '/home/me';

function checked(
	candidate: FeedbackAccountCandidate,
	status: FeedbackAccount['status']
): FeedbackAccount {
	return { ...candidate, status };
}

describe('buildFeedbackAccountCandidates', () => {
	it('runs as each agent account, deduped, most-used first, with the provider defaults after', () => {
		const candidates = buildFeedbackAccountCandidates({
			agents: [
				{
					name: 'Solo',
					toolType: 'claude-code',
					customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-solo' },
				},
				{
					name: 'Work A',
					toolType: 'claude-code',
					customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
				},
				{
					name: 'Work B',
					toolType: 'claude-code',
					customEnvVars: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work/' },
				},
				{ name: 'Terminal', toolType: 'terminal' },
			],
			providerEnvByToolType: {},
			homeDir: HOME,
		});

		expect(candidates.map((c) => c.key)).toEqual([
			'claude-code::/home/me/.claude-work',
			'claude-code::/home/me/.claude-solo',
			'claude-code::/home/me/.claude',
			'codex::/home/me/.codex',
			'opencode',
		]);
		expect(candidates[0].agentNames).toEqual(['Work A', 'Work B']);
		expect(candidates[0].env).toEqual({ CLAUDE_CONFIG_DIR: '/home/me/.claude-work' });
		expect(candidates[2].source).toBe('provider-default');
	});

	it('gives an agent without its own env the provider-level env, which replaces rather than layers', () => {
		const providerEnv = { CODEX_HOME: '/home/me/.codex-team' };
		const candidates = buildFeedbackAccountCandidates({
			agents: [
				{ name: 'Inherits', toolType: 'codex' },
				{ name: 'Own key', toolType: 'codex', customEnvVars: { OPENAI_API_KEY: 'sk-abcd1234' } },
			],
			providerEnvByToolType: { codex: providerEnv },
			homeDir: HOME,
		});
		const inherits = candidates.find((c) => c.agentNames.includes('Inherits'))!;
		expect(inherits.env).toEqual(providerEnv);
		const ownKey = candidates.find((c) => c.agentNames.includes('Own key'))!;
		expect(ownKey.env).toEqual({ OPENAI_API_KEY: 'sk-abcd1234' });
		// The bare default login is still offered, with an explicit empty env so
		// the provider-level CODEX_HOME does not leak back in.
		const bare = candidates.find((c) => c.key === 'codex::/home/me/.codex')!;
		expect(bare.env).toEqual({});
	});

	it('keeps an SSH agent account apart from the local one with the same dir', () => {
		const candidates = buildFeedbackAccountCandidates({
			agents: [
				{
					name: 'Remote',
					toolType: 'claude-code',
					cwd: '/srv/app',
					sshRemote: { id: 'r1', name: 'box' },
				},
			],
			providerEnvByToolType: {},
			homeDir: HOME,
		});
		const remote = candidates.find((c) => c.sshRemoteId === 'r1')!;
		expect(remote.remoteCwd).toBe('/srv/app');
		expect(remote.label).toContain('@ box');
		expect(
			candidates.some((c) => c.key === 'claude-code::/home/me/.claude' && !c.sshRemoteId)
		).toBe(true);
	});
});

describe('orderFeedbackAccounts', () => {
	const all = buildFeedbackAccountCandidates({
		agents: [
			{ name: 'W', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/a' } },
			{ name: 'W2', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/a' } },
			{ name: 'S', toolType: 'claude-code', customEnvVars: { CLAUDE_CONFIG_DIR: '/b' } },
			{ name: 'R', toolType: 'claude-code', sshRemote: { id: 'r1' } },
		],
		providerEnvByToolType: {},
		homeDir: HOME,
	});
	const byKey = (key: string) => all.find((c) => c.key === key)!;
	const work = byKey('claude-code::/a');
	const solo = byKey('claude-code::/b');
	const local = byKey('claude-code::/home/me/.claude');
	const remote = all.find((c) => c.sshRemoteId === 'r1')!;

	it('puts signed-in local accounts first, guesses after, and SSH accounts last', () => {
		const ordered = orderFeedbackAccounts(
			[
				checked(remote, 'unknown'),
				checked(work, 'not-logged-in'),
				checked(solo, 'ready'),
				checked(local, 'not-installed'),
			],
			null
		);
		expect(ordered.map((a) => a.key)).toEqual([solo.key, work.key, local.key, remote.key]);
		expect(ordered.filter(isFeedbackAccountUsable).map((a) => a.key)).toEqual([
			solo.key,
			work.key,
			remote.key,
		]);
	});

	it('tries the last account that worked first, unless it is no longer installed', () => {
		const accounts = [checked(solo, 'ready'), checked(work, 'not-logged-in')];
		expect(orderFeedbackAccounts(accounts, work.key)[0].key).toBe(work.key);
		const gone = [checked(solo, 'ready'), checked(work, 'not-installed')];
		expect(orderFeedbackAccounts(gone, work.key)[0].key).toBe(solo.key);
	});
});
