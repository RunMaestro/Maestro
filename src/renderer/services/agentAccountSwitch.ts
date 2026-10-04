/**
 * agentAccountSwitch - move an agent onto another provider account without a
 * login round trip.
 *
 * Every account listed already holds its own credentials in its own config dir,
 * so the switch is an env edit plus making open conversations resumable from
 * the new dir. The decisions (who may switch, what the env becomes) live in
 * `src/shared/providerAccountSwitch.ts`; this module reads the live inputs the
 * spawner will use and applies the result.
 *
 * Two surfaces call it - the Switch Account modal and, through that modal, the
 * quota outage card - so the env they write and the conversations they carry
 * cannot drift apart.
 */

import { useSessionStore, selectSessionById, updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { getRetryEntry } from '../stores/retryStore';
import { getHomeDir, getHomeDirAsync } from '../utils/homeDir';
import { resolveAgentEnvironment } from '../../shared/agentEnvironment';
import {
	effectiveAgentCustomEnvVars,
	getAccountKeyHelpers,
	getProviderProfileConfig,
	resolveAgentAccountKey,
} from '../../shared/providerProfiles';
import {
	accountSwitchBlocker,
	accountSwitchEnv,
	type ProviderAccountIdentity,
} from '../../shared/providerAccountSwitch';
import type { Session } from '../types';

export interface AgentAccountContext {
	/** Why this agent cannot switch accounts, or null when it can. */
	blocker: string | null;
	/** The account the agent runs as right now. Null when it cannot be resolved. */
	currentAccountKey: string | null;
	/** Every account dir for the provider, with who is signed into it. */
	identities: ProviderAccountIdentity[];
}

async function resolveHomeDir(): Promise<string> {
	return getHomeDir() ?? (await getHomeDirAsync()) ?? '';
}

async function readProviderEnv(toolType: string): Promise<Record<string, string>> {
	return (await window.maestro.agents.getCustomEnvVars(toolType)) ?? {};
}

/** The account the agent's process is pointed at, from the env the spawner builds. */
function currentAccountKey(
	session: Session,
	providerEnv: Record<string, string>,
	homeDir: string
): string | null {
	const env = {
		...useSettingsStore.getState().shellEnvVars,
		...effectiveAgentCustomEnvVars(session.customEnvVars, providerEnv),
	};
	return resolveAgentAccountKey(session.toolType, env, homeDir || undefined);
}

function blockerFor(session: Session, providerEnv: Record<string, string>): string | null {
	// Classified against the spawner's full layer stack, because a key or a
	// gateway set at ANY layer outranks the config dir's login.
	const env = Object.fromEntries(
		resolveAgentEnvironment({
			global: useSettingsStore.getState().shellEnvVars,
			agent: providerEnv,
			session: session.customEnvVars,
		}).map((entry) => [entry.key, entry.value])
	);
	return accountSwitchBlocker({
		toolType: session.toolType,
		env,
		agentName: session.name,
		remote: Boolean(session.sessionSshRemoteConfig?.enabled),
	});
}

/**
 * A tab whose turn is running would have its transcript copied mid-write, and
 * its process keeps the account it was spawned with anyway. A tab waiting on a
 * scheduled auto-retry is not running anything - that is exactly the moment a
 * spent quota sends the user here.
 */
function runningTurn(session: Session): boolean {
	return session.aiTabs.some(
		(tab) => tab.state === 'busy' && getRetryEntry(session.id, tab.id)?.status !== 'scheduled'
	);
}

/** Everything the Switch Account modal needs that is not already in a store. */
export async function loadAgentAccountContext(session: Session): Promise<AgentAccountContext> {
	const [providerEnv, homeDir] = await Promise.all([
		readProviderEnv(session.toolType),
		resolveHomeDir(),
	]);
	const blocker = blockerFor(session, providerEnv);
	if (blocker) return { blocker, currentAccountKey: null, identities: [] };
	const identities = await window.maestro.agents.getProviderAccounts(session.toolType);
	return {
		blocker: null,
		currentAccountKey: currentAccountKey(session, providerEnv, homeDir),
		identities,
	};
}

export type SwitchAgentAccountResult =
	| { ok: true; unchanged?: boolean; missingConversations: number }
	| { ok: false; error: string };

/**
 * Point `sessionId` at `targetAccountKey`. The next turn on every tab runs on
 * the new account and resumes the conversation it was in.
 */
export async function switchAgentAccount(
	sessionId: string,
	targetAccountKey: string
): Promise<SwitchAgentAccountResult> {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	if (!session) return { ok: false, error: 'That agent no longer exists.' };
	const config = getProviderProfileConfig(session.toolType);

	const [providerEnv, homeDir] = await Promise.all([
		readProviderEnv(session.toolType),
		resolveHomeDir(),
	]);
	const blocker = blockerFor(session, providerEnv);
	if (blocker || !config) return { ok: false, error: blocker ?? 'This agent has no accounts.' };
	if (!homeDir) return { ok: false, error: 'Could not resolve your home directory.' };
	if (runningTurn(session)) {
		return {
			ok: false,
			error: `${session.name} is in the middle of a turn. Switch once it finishes.`,
		};
	}

	const target = getAccountKeyHelpers(session.toolType)!.normalizeKey(targetAccountKey);
	const fromAccountKey = currentAccountKey(session, providerEnv, homeDir);
	if (fromAccountKey === target) {
		return { ok: true, unchanged: true, missingConversations: 0 };
	}

	// Carry before writing the env: if a copy fails, the agent stays on the
	// account whose transcripts it can still resume.
	let missingConversations = 0;
	if (fromAccountKey) {
		const sessionIds = new Set(
			session.aiTabs.map((tab) => tab.agentSessionId).filter((id): id is string => !!id)
		);
		for (const providerSessionId of sessionIds) {
			const result = await window.maestro.agents.carryProviderSession({
				toolType: session.toolType,
				fromAccountKey,
				toAccountKey: target,
				sessionId: providerSessionId,
				cwd: session.cwd,
			});
			if (result === 'missing') missingConversations += 1;
		}
	}

	const nextEnv = accountSwitchEnv({
		toolType: session.toolType,
		sessionEnv: session.customEnvVars,
		providerEnv,
		globalEnv: useSettingsStore.getState().shellEnvVars,
		homeDir,
		targetAccountKey: target,
	});

	updateSessionWith(sessionId, (s) => {
		// A live value wins its key outright: a parked copy of the same var would
		// be unreachable state that re-enabling could resurrect over the switch.
		let parked = s.customEnvVarsDisabled;
		if (parked && config.envVar in parked && config.envVar in nextEnv) {
			parked = { ...parked };
			delete parked[config.envVar];
		}
		return {
			...s,
			customEnvVars: nextEnv,
			customEnvVarsDisabled: parked,
			// Both fields describe the account being left. The header's quota bars
			// prefer the stamped snapshot key, so a stale one keeps drawing the old
			// account's bars; and a sticky `limit` holds API mode for as long as the
			// NEW account's windows are open, which on a fresh account is always.
			claudeInteractive: s.claudeInteractive
				? { ...s.claudeInteractive, modeReason: 'auto', lastUsageSnapshotKey: undefined }
				: s.claudeInteractive,
		};
	});

	return { ok: true, missingConversations };
}
