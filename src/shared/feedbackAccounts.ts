/**
 * Which provider account runs the Send Feedback interview.
 *
 * The feedback chat used to pick a provider TYPE (the first of Claude Code,
 * Codex, OpenCode that detection found) and spawn it with no per-agent env. That
 * ran on the default `~/.claude` / `~/.codex` login, which is not an account
 * anybody who switches accounts per agent has signed into, so the chat failed
 * with an OAuth error while every one of their agents worked.
 *
 * Candidates are therefore built from the user's own agents: each agent's
 * effective env (through {@link effectiveAgentCustomEnvVars}, the same
 * replace-not-layer rule the spawner applies) resolves to an account via
 * {@link resolveAgentProfile}, deduped by that account. The provider-level
 * defaults ride along as fallbacks. Main checks each one and orders them; the
 * renderer uses the first and falls through to the next when a first turn
 * fails.
 *
 * Pure: no fs, no Electron. `src/main/feedback/accounts.ts` supplies the store
 * reads and the checks, so the desktop modal and `maestro-cli feedback accounts`
 * see one list.
 */

import { effectiveAgentCustomEnvVars, resolveAgentProfile } from './providerProfiles';

/** Providers the feedback interview knows how to drive, in fallback order. */
export const FEEDBACK_PROVIDERS = ['claude-code', 'codex', 'opencode'] as const;
export type FeedbackProvider = (typeof FEEDBACK_PROVIDERS)[number];

export function isFeedbackProvider(toolType: string): toolType is FeedbackProvider {
	return (FEEDBACK_PROVIDERS as readonly string[]).includes(toolType);
}

/**
 * What the cheap pre-check concluded. Only `not-installed` excludes an account
 * from the automatic pick: `not-logged-in` is a file-based guess (a key in the
 * global environment or the macOS keychain can still sign it in), so it is
 * ordered last and still tried.
 */
export type FeedbackAccountStatus = 'ready' | 'unknown' | 'not-logged-in' | 'not-installed';

/** One agent, as far as account selection needs it. */
export interface FeedbackAccountSource {
	name: string;
	toolType: string;
	customEnvVars?: Record<string, string>;
	customPath?: string;
	cwd?: string;
	/** Set when the agent runs over SSH. */
	sshRemote?: { id: string; name?: string } | null;
}

export interface FeedbackAccount {
	/** Provider profile key (`claude-code::/Users/me/.claude-work`). Stable across runs. */
	key: string;
	toolType: FeedbackProvider;
	/** `Claude Code - work`. */
	label: string;
	/** Env passed as the spawn's `sessionCustomEnvVars`. It replaces the provider-level set. */
	env: Record<string, string>;
	/** Binary override carried by the agent this account came from. */
	customPath?: string;
	/** SSH remote the account lives on, or null for this machine. */
	sshRemoteId: string | null;
	/** Working directory on the remote, for an SSH account. */
	remoteCwd?: string;
	/** Agents that run on this account. Empty for a provider default nobody uses. */
	agentNames: string[];
	source: 'agent' | 'provider-default';
	status: FeedbackAccountStatus;
	/** Why the status is what it is, in words a user can act on. */
	statusDetail?: string;
}

export type FeedbackAccountCandidate = Omit<FeedbackAccount, 'status' | 'statusDetail'>;

export interface FeedbackAccountsResponse {
	/** Ordered: the automatic pick is the first entry `isFeedbackAccountUsable` accepts. */
	accounts: FeedbackAccount[];
	/** The account that last carried a conversation, if it is still in the list. */
	lastWorkingKey: string | null;
}

export interface BuildFeedbackAccountsInput {
	agents: FeedbackAccountSource[];
	/** Settings -> Agents env per provider. */
	providerEnvByToolType: Record<string, Record<string, string> | undefined>;
	homeDir: string | undefined;
}

/**
 * Every distinct account the feedback chat could run as, unchecked.
 *
 * Agent accounts come first, most-used first, because an account several agents
 * run on is the one most likely to be signed in. Provider defaults follow: the
 * provider-level env (what an agent with no overrides of its own receives), then
 * the bare default login when that env points somewhere else.
 */
export function buildFeedbackAccountCandidates(
	input: BuildFeedbackAccountsInput
): FeedbackAccountCandidate[] {
	const byKey = new Map<string, FeedbackAccountCandidate>();
	const order: string[] = [];

	const add = (candidate: FeedbackAccountCandidate, agentName?: string) => {
		const existing = byKey.get(candidate.key);
		if (existing) {
			if (agentName) existing.agentNames.push(agentName);
			return;
		}
		byKey.set(candidate.key, candidate);
		order.push(candidate.key);
	};

	for (const agent of input.agents) {
		if (!isFeedbackProvider(agent.toolType)) continue;
		const env = effectiveAgentCustomEnvVars(
			agent.customEnvVars,
			input.providerEnvByToolType[agent.toolType]
		);
		const remote = agent.sshRemote ?? null;
		const profile = resolveAgentProfile(agent.toolType, env, input.homeDir, remote);
		if (!profile) continue;
		add(
			{
				key: profile.key,
				toolType: agent.toolType,
				label: profile.label,
				env,
				customPath: agent.customPath?.trim() || undefined,
				sshRemoteId: profile.sshRemoteId,
				remoteCwd: profile.sshRemoteId ? agent.cwd : undefined,
				agentNames: [agent.name],
				source: 'agent',
			},
			agent.name
		);
	}

	const agentKeys = order.slice();
	agentKeys.sort((a, b) => byKey.get(b)!.agentNames.length - byKey.get(a)!.agentNames.length);

	const defaultKeys: string[] = [];
	for (const toolType of FEEDBACK_PROVIDERS) {
		const providerEnv = input.providerEnvByToolType[toolType] ?? {};
		// `{}` is an explicit override, so it suppresses the provider-level set and
		// lands on the provider's own default login.
		for (const env of [providerEnv, {}]) {
			const profile = resolveAgentProfile(toolType, env, input.homeDir);
			if (!profile || byKey.has(profile.key)) continue;
			add({
				key: profile.key,
				toolType,
				label: `${profile.label} (default)`,
				env,
				sshRemoteId: null,
				agentNames: [],
				source: 'provider-default',
			});
			defaultKeys.push(profile.key);
		}
	}

	return [...agentKeys, ...defaultKeys].map((key) => byKey.get(key)!);
}

const STATUS_RANK: Record<FeedbackAccountStatus, number> = {
	ready: 0,
	unknown: 1,
	'not-logged-in': 2,
	'not-installed': 3,
};

/** Whether the automatic pick may try this account. */
export function isFeedbackAccountUsable(account: FeedbackAccount): boolean {
	return account.status !== 'not-installed';
}

/**
 * Order checked accounts for the automatic pick: the last account that worked,
 * then local accounts by status, then SSH accounts. A remote account answers
 * about the remote machine, not this one, so it is a last resort. The sort is
 * stable, so candidate order breaks ties.
 */
export function orderFeedbackAccounts(
	accounts: FeedbackAccount[],
	lastWorkingKey: string | null
): FeedbackAccount[] {
	const rank = (account: FeedbackAccount) =>
		(account.sshRemoteId ? 100 : 0) +
		STATUS_RANK[account.status] * 10 -
		(account.key === lastWorkingKey && isFeedbackAccountUsable(account) ? 1000 : 0);
	return accounts
		.map((account, index) => ({ account, index }))
		.sort((a, b) => rank(a.account) - rank(b.account) || a.index - b.index)
		.map(({ account }) => account);
}

/** Short tag for a status, for a picker row. */
export function describeFeedbackAccountStatus(account: FeedbackAccount): string {
	switch (account.status) {
		case 'ready':
			return 'signed in';
		case 'unknown':
			return 'not checked';
		case 'not-logged-in':
			return 'not signed in';
		case 'not-installed':
			return 'not installed';
	}
}
