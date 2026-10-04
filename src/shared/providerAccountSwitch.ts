/**
 * Switching the provider account an agent runs as.
 *
 * An account is whichever config directory the agent's process receives
 * (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), so switching one is an env edit, never a
 * login: every directory listed here already holds its own credentials. This
 * module owns the three decisions that have to agree everywhere a switch can be
 * offered (the Switch Account modal, the quota outage card):
 *
 *   - {@link accountSwitchBlocker}: whether swapping accounts can change what the
 *     agent presents at all. An API key, a gateway, or Bedrock/Vertex OUTRANKS
 *     the config dir's login, so pointing the agent at another directory would
 *     look like a switch and bill the same credential. Same failure class
 *     `ReauthModal` guards against with `credentialKindBlocksLogin()`.
 *   - {@link buildSwitchableAccounts}: the candidate list, labeled by the
 *     account's IDENTITY (the login email) rather than the directory name,
 *     because directory names are chosen once and nothing keeps them honest.
 *     Ordered so the account to switch TO when a window is spent comes first.
 *   - {@link accountSwitchEnv}: the agent env that selects the new account,
 *     built on the same replace-not-layer rule the spawner applies.
 *
 * Pure: no fs, no Electron. Main supplies identities, the renderer supplies the
 * quota snapshots it already mirrors for the Usage Dashboard.
 */

import { getAgentDisplayName } from './agentMetadata';
import { classifyCredentialKind, type CredentialClassification } from './providerAuthIdentity';
import {
	effectiveAgentCustomEnvVars,
	getAccountKeyHelpers,
	getProviderProfileConfig,
	resolveAgentAccountKey,
} from './providerProfiles';

/** What main can read off disk about one account directory. */
export interface ProviderAccountIdentity {
	/** Canonical account key: the config dir, trailing slashes stripped. */
	accountKey: string;
	/** Login email, when the directory records one. */
	email?: string;
	/** Whether the directory holds a login at all. */
	signedIn: boolean;
}

export interface CarryProviderSessionRequest {
	toolType: string;
	fromAccountKey: string;
	toAccountKey: string;
	/** The provider session id the tab resumes with. */
	sessionId: string;
	/** The agent's working directory; Claude files transcripts per project. */
	cwd: string;
}

/**
 * - `shared`: both accounts read the same transcript folder.
 * - `present`: the target already has this conversation.
 * - `copied`: the transcript was copied into the target account.
 * - `missing`: the source transcript was not found, so the next turn starts a
 *   new conversation on the target account.
 */
export type CarryProviderSessionResult = 'shared' | 'present' | 'copied' | 'missing';

/** One rate-limit window as the switcher needs it. */
export interface AccountQuotaWindow {
	/** `Session`, `Weekly`, or the provider's own name for a sublimit. */
	label: string;
	/** 0-100. */
	percent: number;
	/** ISO timestamp the window reopens, when the provider reported one. */
	resetsAt?: string;
}

export interface SwitchableAccount {
	accountKey: string;
	/** The login email when known, otherwise the directory's short name. */
	label: string;
	email?: string;
	/** `~/.claude-work` style name of the directory, shown beside the identity. */
	dirLabel: string;
	signedIn: boolean;
	isCurrent: boolean;
	/** Windows from the most recent usage sample, empty when never sampled. */
	windows: AccountQuotaWindow[];
	/** Highest window percentage, or undefined when never sampled. */
	peakPercent?: number;
	/** True when any window is at 100%: the account cannot run a turn right now. */
	exhausted: boolean;
	/** When the latest exhausted window reopens. Undefined when not exhausted or unknown. */
	reopensAt?: string;
}

/** A window at or above this is spent: the provider refuses the next turn. */
export const EXHAUSTED_PERCENT = 100;

/**
 * Why accounts cannot be switched for this agent, or null when they can.
 *
 * `env` must be the agent's effective environment as the spawner builds it
 * (`resolveAgentEnvironment()`: global, then provider, then agent). A
 * classification from a different merge describes a process nobody is running.
 */
export function accountSwitchBlocker(input: {
	toolType: string;
	env: Record<string, string>;
	agentName: string;
	/** True when the agent runs over SSH. */
	remote: boolean;
}): string | null {
	const { toolType, env, agentName } = input;
	const config = getProviderProfileConfig(toolType);
	if (!config) {
		return `${getAgentDisplayName(toolType)} keeps a single credential store, so there is no other account to switch ${agentName} to.`;
	}
	if (input.remote) {
		return `${agentName} runs over SSH. Its accounts live on the remote host, which Maestro cannot list from here.`;
	}
	return credentialKindBlocksSwitch(classifyCredentialKind(toolType, env), agentName);
}

function credentialKindBlocksSwitch(
	classification: CredentialClassification,
	agentName: string
): string | null {
	const named = classification.envVarName ?? 'its environment';
	switch (classification.kind) {
		case 'oauth':
			return null;
		case 'api-key':
			return `${agentName} authenticates with the key in ${named}, which outranks any login. Switching accounts would not change what it bills.`;
		case 'gateway':
			return `${agentName} is pointed at ${classification.label ?? 'a gateway'} by ${named}. The credential belongs to that operator, so a provider account switch would not change it.`;
		case 'cloud-provider':
			return `${agentName} runs against ${classification.label ?? 'a cloud provider'} via ${named}, which takes its credentials from the cloud SDK chain rather than a provider login.`;
	}
}

/** The latest reset among the windows that are spent. */
function latestReopen(windows: AccountQuotaWindow[]): string | undefined {
	let latest: string | undefined;
	let latestMs = -Infinity;
	for (const window of windows) {
		if (window.percent < EXHAUSTED_PERCENT || !window.resetsAt) continue;
		const ms = Date.parse(window.resetsAt);
		if (Number.isFinite(ms) && ms > latestMs) {
			latestMs = ms;
			latest = window.resetsAt;
		}
	}
	return latest;
}

/**
 * Rank: the current account first (so the list always says where the agent is),
 * then accounts that can run a turn now, least used first, then spent accounts,
 * soonest to reopen first, then directories with no login.
 */
function rank(account: SwitchableAccount): number {
	if (account.isCurrent) return 0;
	if (!account.signedIn) return 3;
	return account.exhausted ? 2 : 1;
}

/**
 * Every account the agent could be switched to, labeled by identity.
 *
 * Windows whose reset time has already passed are dropped before deciding
 * whether an account is spent: a snapshot taken during the outage keeps saying
 * 100% until it is re-sampled, and an account whose window reopened an hour ago
 * is exactly the one to switch to.
 */
export function buildSwitchableAccounts(input: {
	toolType: string;
	identities: ProviderAccountIdentity[];
	quotaByAccountKey: Record<string, AccountQuotaWindow[] | undefined>;
	currentAccountKey: string | null;
	now: number;
}): SwitchableAccount[] {
	const helpers = getAccountKeyHelpers(input.toolType);
	if (!helpers) return [];
	const current = input.currentAccountKey ? helpers.normalizeKey(input.currentAccountKey) : null;
	const seen = new Set<string>();
	const accounts: SwitchableAccount[] = [];

	for (const identity of input.identities) {
		const accountKey = helpers.normalizeKey(identity.accountKey);
		if (seen.has(accountKey)) continue;
		seen.add(accountKey);

		const windows = (input.quotaByAccountKey[accountKey] ?? []).filter((window) => {
			if (window.percent < EXHAUSTED_PERCENT || !window.resetsAt) return true;
			const ms = Date.parse(window.resetsAt);
			return !Number.isFinite(ms) || ms > input.now;
		});
		const exhausted = windows.some((window) => window.percent >= EXHAUSTED_PERCENT);
		const basename = accountKey.split(/[\\/]/).pop() || accountKey;
		accounts.push({
			accountKey,
			label: identity.email || helpers.deriveDisplayName(accountKey),
			email: identity.email,
			dirLabel: `~/${basename}`,
			signedIn: identity.signedIn,
			isCurrent: accountKey === current,
			windows,
			peakPercent: windows.length
				? Math.max(...windows.map((window) => window.percent))
				: undefined,
			exhausted,
			reopensAt: exhausted ? latestReopen(windows) : undefined,
		});
	}

	return accounts.sort((a, b) => {
		const byRank = rank(a) - rank(b);
		if (byRank !== 0) return byRank;
		if (a.exhausted && b.exhausted) {
			const aMs = a.reopensAt ? Date.parse(a.reopensAt) : Infinity;
			const bMs = b.reopensAt ? Date.parse(b.reopensAt) : Infinity;
			if (aMs !== bMs) return aMs - bMs;
		}
		const byUse = (a.peakPercent ?? 0) - (b.peakPercent ?? 0);
		if (byUse !== 0) return byUse;
		return a.label.localeCompare(b.label);
	});
}

/** The account to suggest: the first one that is signed in, not current, and not spent. */
export function recommendedAccount(accounts: SwitchableAccount[]): SwitchableAccount | undefined {
	return accounts.find((account) => !account.isCurrent && account.signedIn && !account.exhausted);
}

/**
 * The agent's own `customEnvVars` after switching it to `targetAccountKey`.
 *
 * Built from {@link effectiveAgentCustomEnvVars}, the set the process actually
 * receives. An agent's own vars REPLACE the provider-level set rather than
 * layering over it, so writing just the one config-dir var onto an agent that
 * had none would silently drop every provider-level var it was inheriting.
 * Copying that set in keeps the process identical apart from the account.
 *
 * The provider's default directory is selected by REMOVING the var, not by
 * naming `~/.claude`: Claude reads `.claude.json` from `$HOME` only when
 * `CLAUDE_CONFIG_DIR` is unset, so an explicit `~/.claude` points it at a file
 * that does not exist and the default login reads as signed out. When the
 * global layer sets the var, a blank value is written instead, because a blank
 * at a higher layer is what cancels a value set lower down.
 */
export function accountSwitchEnv(input: {
	toolType: string;
	sessionEnv: Record<string, string> | undefined;
	providerEnv: Record<string, string> | undefined;
	globalEnv: Record<string, string> | undefined;
	homeDir: string;
	targetAccountKey: string;
}): Record<string, string> {
	const config = getProviderProfileConfig(input.toolType);
	if (!config) throw new Error(`${input.toolType} has no switchable accounts`);
	const env = { ...effectiveAgentCustomEnvVars(input.sessionEnv, input.providerEnv) };
	const defaultKey = resolveAgentAccountKey(input.toolType, {}, input.homeDir);
	const target = getAccountKeyHelpers(input.toolType)!.normalizeKey(input.targetAccountKey);
	if (target === defaultKey) {
		const globalValue = input.globalEnv?.[config.envVar];
		if (globalValue !== undefined && globalValue.trim() !== '') env[config.envVar] = '';
		else delete env[config.envVar];
	} else {
		env[config.envVar] = target;
	}
	return env;
}

interface SnapshotWindow {
	percent: number;
	resetsAt?: string;
}

/**
 * Windows from a Claude usage snapshot (`maestro-p --status`). An
 * unauthenticated snapshot carries zeroes, not usage, so it yields none.
 */
export function claudeSnapshotWindows(snapshot: {
	authState?: 'authenticated' | 'unauthenticated';
	session: SnapshotWindow;
	weekAllModels: SnapshotWindow;
	weekSonnetOnly: SnapshotWindow & { label?: string };
}): AccountQuotaWindow[] {
	if (snapshot.authState === 'unauthenticated') return [];
	return [
		{ label: 'Session', ...snapshot.session },
		{ label: 'Weekly', ...snapshot.weekAllModels },
		{
			label: snapshot.weekSonnetOnly.label
				? `Weekly ${snapshot.weekSonnetOnly.label}`
				: 'Weekly premium',
			percent: snapshot.weekSonnetOnly.percent,
			resetsAt: snapshot.weekSonnetOnly.resetsAt,
		},
	];
}

/** Windows from a Codex quota snapshot. Only an authenticated sample carries usage. */
export function codexSnapshotWindows(snapshot: {
	authState: string;
	session?: SnapshotWindow;
	weekly?: SnapshotWindow;
	additionalLimits?: Array<SnapshotWindow & { name: string }>;
}): AccountQuotaWindow[] {
	if (snapshot.authState !== 'authenticated') return [];
	const windows: AccountQuotaWindow[] = [];
	if (snapshot.session) windows.push({ label: 'Session', ...snapshot.session });
	if (snapshot.weekly) windows.push({ label: 'Weekly', ...snapshot.weekly });
	for (const limit of snapshot.additionalLimits ?? []) {
		windows.push({ label: limit.name, percent: limit.percent, resetsAt: limit.resetsAt });
	}
	return windows;
}
