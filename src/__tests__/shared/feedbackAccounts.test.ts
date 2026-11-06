import { afterEach, describe, expect, it } from 'vitest';

import {
	buildFeedbackAccountCandidates,
	describeFeedbackAccountStatus,
	FEEDBACK_PROVIDERS,
	feedbackInterviewRouteProblem,
	isFeedbackAccountUsable,
	orderFeedbackAccounts,
	type FeedbackAccount,
	type FeedbackAccountCandidate,
} from '../../shared/feedbackAccounts';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';

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
			'grok::/home/me/.grok',
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

describe('Grok feedback accounts', () => {
	const definition = getAgentDefinition('grok')!;
	const enforced = definition.readOnlyCliEnforced;
	afterEach(() => {
		definition.readOnlyCliEnforced = enforced;
	});

	it('lists Grok last, so its provider default never displaces an earlier automatic pick', () => {
		expect(FEEDBACK_PROVIDERS[FEEDBACK_PROVIDERS.length - 1]).toBe('grok');
	});

	it('keeps two selected Grok roots apart, dedupes agents on one root, and adds the provider default', () => {
		const candidates = buildFeedbackAccountCandidates({
			agents: [
				{ name: 'Work A', toolType: 'grok', customEnvVars: { GROK_HOME: '/home/me/.grok-work' } },
				{ name: 'Work B', toolType: 'grok', customEnvVars: { GROK_HOME: '/home/me/.grok-work/' } },
				{ name: 'Play', toolType: 'grok', customEnvVars: { GROK_HOME: '/home/me/.grok-play' } },
			],
			providerEnvByToolType: {},
			homeDir: HOME,
		});
		const grok = candidates.filter((c) => c.toolType === 'grok');
		expect(grok.map((c) => [c.key, c.source, c.agentNames])).toEqual([
			['grok::/home/me/.grok-work', 'agent', ['Work A', 'Work B']],
			['grok::/home/me/.grok-play', 'agent', ['Play']],
			['grok::/home/me/.grok', 'provider-default', []],
		]);
		expect(grok[0].env).toEqual({ GROK_HOME: '/home/me/.grok-work' });
		expect(grok[2].label).toBe('Grok CLI - Default account (default)');
		expect(grok[2].env).toEqual({});
	});

	it('merges an agent on the provider-level root with the provider default instead of listing it twice', () => {
		const candidates = buildFeedbackAccountCandidates({
			agents: [{ name: 'Inherits', toolType: 'grok' }],
			providerEnvByToolType: { grok: { GROK_HOME: '/home/me/.grok-team' } },
			homeDir: HOME,
		});
		const grok = candidates.filter((c) => c.toolType === 'grok');
		expect(grok.map((c) => c.key)).toEqual(['grok::/home/me/.grok-team', 'grok::/home/me/.grok']);
		expect(grok[0].env).toEqual({ GROK_HOME: '/home/me/.grok-team' });
		// The bare default does not inherit the provider-level root back.
		expect(grok[1].env).toEqual({});
	});

	it('never lists a Grok agent whose credential names no account root, and never copies its secret', () => {
		const candidates = buildFeedbackAccountCandidates({
			agents: [
				{
					name: 'Inline',
					toolType: 'grok',
					customEnvVars: { GROK_AUTH: '{"token":"secret-body"}' },
				},
			],
			providerEnvByToolType: {},
			homeDir: HOME,
		});
		expect(candidates.some((c) => c.agentNames.includes('Inline'))).toBe(false);
		expect(JSON.stringify(candidates)).not.toContain('secret-body');
	});

	it('keeps an SSH Grok account apart from the local default with the same root', () => {
		const candidates = buildFeedbackAccountCandidates({
			agents: [
				{ name: 'Remote', toolType: 'grok', cwd: '/srv/app', sshRemote: { id: 'h1', name: 'box' } },
			],
			providerEnvByToolType: {},
			homeDir: HOME,
		});
		const remote = candidates.find((c) => c.sshRemoteId === 'h1')!;
		expect(remote).toMatchObject({ toolType: 'grok', remoteCwd: '/srv/app' });
		expect(remote.label).toContain('@ box');
		expect(candidates.some((c) => c.key === 'grok::/home/me/.grok' && !c.sshRemoteId)).toBe(true);
	});

	it('qualifies the Grok interview route from the definition, and names the gap once it is lost', () => {
		expect(feedbackInterviewRouteProblem('grok')).toBeNull();
		definition.readOnlyCliEnforced = false;
		expect(feedbackInterviewRouteProblem('grok')).toBe(
			'Grok CLI has no CLI-enforced read-only mode, so the feedback interview does not run on it'
		);
		// Providers outside the qualified set need no proof from this rule.
		expect(feedbackInterviewRouteProblem('opencode')).toBeNull();
	});

	it('never lets an unsupported or missing Grok account lead, even when it was the remembered choice', () => {
		const [work, , def] = buildFeedbackAccountCandidates({
			agents: [{ name: 'W', toolType: 'grok', customEnvVars: { GROK_HOME: '/g/work' } }],
			providerEnvByToolType: {},
			homeDir: HOME,
		}).filter((c) => c.toolType === 'grok' || c.toolType === 'codex');
		const codex = buildFeedbackAccountCandidates({
			agents: [],
			providerEnvByToolType: {},
			homeDir: HOME,
		}).find((c) => c.toolType === 'codex')!;
		expect(work.key).toBe('grok::/g/work');
		expect(def.key).toBe('grok::/home/me/.grok');

		const unsupported = checked(work, 'unsupported');
		expect(isFeedbackAccountUsable(unsupported)).toBe(false);
		expect(describeFeedbackAccountStatus(unsupported)).toBe('not supported');
		const ordered = orderFeedbackAccounts([unsupported, checked(codex, 'not-logged-in')], work.key);
		expect(ordered.map((a) => a.key)).toEqual([codex.key, work.key]);
		expect(ordered.filter(isFeedbackAccountUsable).map((a) => a.toolType)).toEqual(['codex']);

		const missing = checked(def, 'not-installed');
		expect(orderFeedbackAccounts([missing, checked(codex, 'unknown')], def.key)[0].key).toBe(
			codex.key
		);

		// A usable remembered Grok account is tried first.
		const usable = checked(work, 'unknown');
		expect(orderFeedbackAccounts([checked(codex, 'ready'), usable], work.key)[0].key).toBe(
			work.key
		);
	});
});
