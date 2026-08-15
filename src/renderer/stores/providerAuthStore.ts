/**
 * providerAuthStore - renderer mirror of the main-process login-state map.
 *
 * One record per {@link CredentialIdentity}, not per agent. That is the whole
 * point of the identity model: fifteen agents on one Anthropic account read the
 * same snapshot, so they surface one problem instead of fifteen.
 *
 * Ownership: main owns the data (electron-store namespace
 * `provider-auth-snapshots`), this store owns a read cache. Hydration is lazy -
 * the first consumer that mounts pulls the map through
 * `window.maestro.providerAuth.getAll()` and installs the `onChange` listener,
 * so every later write (startup probe, manual re-probe, reactive `auth_expired`
 * mark, a login flow) arrives as a push. Same contract as `claudeUsageStore`,
 * which mirrors the quota map the same way.
 *
 * ## Resolving a session onto a snapshot
 *
 * A snapshot is keyed by identity, and a Session does not carry its identity -
 * it carries the inputs (tool type, `customEnvVars`, SSH config). Resolution
 * runs `mergeEffectiveEnv` + `resolveCredentialIdentity` from
 * `shared/providerAuth.ts`, the same two functions the main-side probe pass
 * calls, so both sides land on the same key. Anything this store has to fetch to
 * do that (the home dir, agent-level `customEnvVars`) is cached here rather than
 * refetched per session.
 *
 * ## Memoization
 *
 * A Session object is replaced on every log append, so resolving identity per
 * render would re-run a SHA-256 fingerprint and a path canonicalization for
 * every agent in the Left Bar on every stdout chunk from any of them. Identities
 * are therefore cached per session id and invalidated on a fingerprint of the
 * four inputs that actually change the answer. `selectLoggedOutIdentities` goes
 * further and returns the PREVIOUS array when the result is unchanged, because
 * zustand v5 compares selector output with `Object.is` and a fresh array on
 * every call would re-render (and warn) forever.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	mergeEffectiveEnv,
	resolveCredentialIdentity,
	type CredentialIdentity,
	type ProviderAuthSnapshot,
	type ProviderAuthSource,
	type ProviderAuthStatus,
} from '../../shared/providerAuth';
import type { Session } from '../types';
import { getHomeDir, getHomeDirAsync } from '../utils/homeDir';
import { logger } from '../utils/logger';
import { notifyToast, useNotificationStore } from './notificationStore';
import { selectSessionById, useSessionStore } from './sessionStore';

const LOG_CONTEXT = '[ProviderAuth]';

/**
 * One logged-out credential plus every agent it blocks.
 *
 * `sessionIds` is what makes the surfacing honest: the user's question is never
 * "which key expired" but "what of mine is broken", and the answer is a list of
 * agents.
 */
export interface BlockedIdentity {
	identity: CredentialIdentity;
	snapshot: ProviderAuthSnapshot;
	/** Sessions presenting this credential, in Left Bar order. */
	sessionIds: string[];
}

/**
 * The two statuses the renderer may write without a probe.
 *
 * `unsupported` is deliberately reused rather than a sixth status being added:
 * an `api-key`, `gateway`, or `cloud-provider` credential that was rejected is
 * not a login that expired, and a login flow cannot repair one. The distinction
 * the UI needs is carried by the status plus the snapshot's `detail`.
 */
export type AuthFailureStatus = Extract<ProviderAuthStatus, 'logged-out' | 'unsupported'>;

/**
 * A failure a renderer observed, as handed to {@link ProviderAuthState.markIdentityAuthFailure}.
 *
 * Either `identityKey` or `identity` identifies the credential; passing the full
 * `identity` is what lets a NEVER-PROBED credential be recorded, since main has
 * no stored record to read it from.
 */
export interface MarkIdentityRequest {
	identityKey?: string;
	identity?: CredentialIdentity;
	/** Defaults to `logged-out`. See {@link AuthFailureStatus}. */
	status?: AuthFailureStatus;
	detail?: string;
	source?: ProviderAuthSource;
}

interface ProviderAuthState {
	/** Snapshot per `CredentialIdentity.key`, mirrored from main. */
	snapshots: Record<string, ProviderAuthSnapshot>;
	/** Agent-level `customEnvVars` per provider, which session-level vars merge over. */
	agentEnvVars: Record<string, Record<string, string>>;
	/** Local home dir, needed to expand the default config dir of an identity. */
	homeDir: string;
	/** True once the first `getAll()` has resolved (success or empty). */
	loaded: boolean;
	/**
	 * Identity keys already announced by a toast in THIS app run.
	 *
	 * Lives in the store rather than a component so an unmounted Left Bar, a
	 * remount, or a second consumer cannot re-announce a login the user has
	 * already been told about. An identity that recovers is dropped from the map,
	 * so a genuinely new logout later in the same run still announces.
	 */
	announcedIdentityKeys: Record<string, true>;

	/** Replace the whole map. Used by hydration and by tests. */
	setSnapshots: (next: Record<string, ProviderAuthSnapshot>) => void;
	/** Apply one pushed write. A null snapshot means the record was cleared. */
	applyChange: (key: string, snapshot: ProviderAuthSnapshot | null) => void;
	/** Pull the map from main and start following changes. Safe to call repeatedly. */
	hydrate: () => Promise<void>;
	/** Record an auth failure against an identity through the bridge. */
	markIdentityAuthFailure: (request: MarkIdentityRequest) => Promise<ProviderAuthSnapshot | null>;
	/** {@link markIdentityAuthFailure} with the `logged-out` status. */
	markIdentityLoggedOut: (
		identityKey: string,
		detail?: string,
		source?: ProviderAuthSource
	) => Promise<ProviderAuthSnapshot | null>;
	/**
	 * Re-probe one credential.
	 *
	 * `source` attributes the resulting snapshot: the recovery modal passes
	 * `login-flow` so the record says a user just finished a login there.
	 */
	refreshIdentity: (
		identityKey: string,
		options?: { source?: ProviderAuthSource }
	) => Promise<void>;
	/** Re-probe every credential (seconds, not milliseconds - it spawns). */
	refreshAllIdentities: () => Promise<void>;
	/** Test-only: reset to initial state and drop every subscription. */
	__resetForTests: () => void;
}

const initialState = {
	snapshots: {} as Record<string, ProviderAuthSnapshot>,
	agentEnvVars: {} as Record<string, Record<string, string>>,
	homeDir: '',
	loaded: false,
	announcedIdentityKeys: {} as Record<string, true>,
};

// ============================================================================
// Bridge access
// ============================================================================

/**
 * The preload API, or null where it does not exist (a test that has not stubbed
 * it, a non-Electron surface). Every caller treats null as "no auth data",
 * which degrades to an unmarked Left Bar rather than a crash.
 */
function bridge(): typeof window.maestro.providerAuth | null {
	return window.maestro?.providerAuth ?? null;
}

// ============================================================================
// Subscriptions
// ============================================================================

let changeUnsubscribe: (() => void) | null = null;
let sessionUnsubscribe: (() => void) | null = null;
let snapshotUnsubscribe: (() => void) | null = null;
let hydratePromise: Promise<void> | null = null;
/** In-flight or completed agent-env fetches, one per provider. */
const agentEnvFetches = new Map<string, Promise<void>>();

/**
 * Fetch (once) the agent-level `customEnvVars` for a provider.
 *
 * These change only through Settings -> Agents, so there is no live channel to
 * follow; a stale value costs at most one wrong identity until the next app run,
 * and the same one-fetch-per-provider shape is what `useQuotaAccounts` already
 * does for the quota panels.
 */
function ensureAgentEnv(toolType: string): Promise<void> {
	if (toolType === '' || toolType === 'terminal') return Promise.resolve();
	const existing = agentEnvFetches.get(toolType);
	if (existing) return existing;

	const fetchEnv = window.maestro?.agents?.getCustomEnvVars;
	if (typeof fetchEnv !== 'function') return Promise.resolve();

	const pending = Promise.resolve(fetchEnv(toolType))
		.then((env) => {
			useProviderAuthStore.setState((state) => ({
				agentEnvVars: { ...state.agentEnvVars, [toolType]: env ?? {} },
			}));
		})
		.catch(() => {
			// Best-effort. An agent with no agent-level vars resolves the same way
			// as one whose fetch failed, so record the empty map and move on.
			useProviderAuthStore.setState((state) => ({
				agentEnvVars: { ...state.agentEnvVars, [toolType]: {} },
			}));
		});
	agentEnvFetches.set(toolType, pending);
	return pending;
}

/** Kick off an env fetch for every provider currently represented in the Left Bar. */
function ensureAgentEnvForSessions(sessions: Session[]): void {
	for (const session of sessions) {
		if (!agentEnvFetches.has(session.toolType)) {
			void ensureAgentEnv(session.toolType);
		}
	}
}

// ============================================================================
// Store
// ============================================================================

export const useProviderAuthStore = create<ProviderAuthState>((set, get) => ({
	...initialState,

	setSnapshots: (next) => set({ snapshots: next, loaded: true }),

	applyChange: (key, snapshot) =>
		set((state) => {
			const next = { ...state.snapshots };
			if (snapshot) next[key] = snapshot;
			else delete next[key];
			return { snapshots: next };
		}),

	hydrate: async () => {
		if (hydratePromise) return hydratePromise;

		hydratePromise = (async () => {
			// Install the listener BEFORE the read, so a write that lands between
			// the two is applied rather than lost behind a stale map.
			const api = bridge();
			if (api && !changeUnsubscribe) {
				changeUnsubscribe = api.onChange((change) => {
					get().applyChange(change.key, change.snapshot);
				});
			}

			const homeDir = getHomeDir();
			if (homeDir) set({ homeDir });
			else {
				await getHomeDirAsync()
					?.then((dir) => set({ homeDir: dir }))
					.catch(() => {});
			}

			const sessions = useSessionStore.getState().sessions;
			ensureAgentEnvForSessions(sessions);
			// A provider that appears later (the user creates their first Codex
			// agent) still needs its agent-level env, and there is no other event
			// that announces one.
			if (!sessionUnsubscribe) {
				sessionUnsubscribe = useSessionStore.subscribe((state, prev) => {
					if (state.sessions === prev.sessions) return;
					ensureAgentEnvForSessions(state.sessions);
					// Only on a change to WHICH agents exist. `sessions` is replaced on
					// every log append, and an announcement pass walks every session, so
					// following the reference itself would run it on every stdout chunk.
					// A count change is what covers the boot race (snapshots hydrate
					// before the agent list loads, so the first pass sees nothing to
					// announce) and a new agent on an already-broken login.
					if (state.sessions.length !== prev.sessions.length) scheduleAnnouncement();
				});
			}
			// Announce on every later write too, not just this first read: the
			// startup probe pass in main can finish after the window mounted, so the
			// map here is often empty at hydration and fills in over the next second.
			if (!snapshotUnsubscribe) {
				snapshotUnsubscribe = useProviderAuthStore.subscribe((state, prev) => {
					if (state.snapshots !== prev.snapshots) scheduleAnnouncement();
				});
			}

			if (!api) {
				set({ loaded: true });
				return;
			}
			try {
				const snapshots = await api.getAll();
				set({ snapshots: snapshots ?? {}, loaded: true });
			} catch (error) {
				// Main-side failures are logged in main; here the cost is an unmarked
				// Left Bar, which is the same thing a fresh install shows.
				logger.warn('Failed to hydrate provider auth snapshots', LOG_CONTEXT, {
					error: error instanceof Error ? error.message : String(error),
				});
				set({ loaded: true });
			}
			scheduleAnnouncement();
		})();

		return hydratePromise;
	},

	markIdentityAuthFailure: async (request) => {
		const key = request.identity?.key ?? request.identityKey;
		if (!key) return null;
		const api = bridge();
		if (!api) return null;
		try {
			const snapshot = await api.mark(key, {
				status: request.status ?? 'logged-out',
				source: request.source ?? 'error-pattern',
				...(request.detail !== undefined ? { detail: request.detail } : {}),
				// Pass the identity through so a credential that has never been
				// probed still gets a record; without it main has nothing to file
				// the mark under and returns null.
				...(request.identity ? { identity: request.identity } : {}),
			});
			// Main broadcasts this write back to every window, but applying it here
			// too means the badge does not wait on a round trip (and shows up in a
			// test that stubs the bridge without the change channel).
			if (snapshot) get().applyChange(key, snapshot);
			return snapshot;
		} catch (error) {
			logger.warn('Failed to mark identity auth failure', LOG_CONTEXT, {
				identityKey: key,
				status: request.status ?? 'logged-out',
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	},

	markIdentityLoggedOut: async (identityKey, detail, source = 'error-pattern') =>
		get().markIdentityAuthFailure({
			identityKey,
			status: 'logged-out',
			source,
			...(detail !== undefined ? { detail } : {}),
			// A key with a stored snapshot needs no identity; one without it can
			// still be marked when the caller resolved the identity itself.
			...(get().snapshots[identityKey]?.identity
				? { identity: get().snapshots[identityKey].identity }
				: {}),
		}),

	refreshIdentity: async (identityKey, options) => {
		const api = bridge();
		if (!api) return;
		try {
			const result = await api.reprobe(
				identityKey,
				options?.source ? { source: options.source } : undefined
			);
			if (result?.snapshot !== undefined) get().applyChange(identityKey, result.snapshot);
		} catch (error) {
			logger.warn('Failed to re-probe identity', LOG_CONTEXT, {
				identityKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	refreshAllIdentities: async () => {
		const api = bridge();
		if (!api) return;
		try {
			await api.reprobeAll();
			// The pass writes through the store in main, so every result already
			// arrived on the change channel. Re-read anyway: a key that was CLEARED
			// while this window was not listening is only visible in the full map.
			const snapshots = await api.getAll();
			set({ snapshots: snapshots ?? {}, loaded: true });
		} catch (error) {
			logger.warn('Failed to re-probe all identities', LOG_CONTEXT, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	},

	__resetForTests: () => {
		changeUnsubscribe?.();
		changeUnsubscribe = null;
		sessionUnsubscribe?.();
		sessionUnsubscribe = null;
		snapshotUnsubscribe?.();
		snapshotUnsubscribe = null;
		hydratePromise = null;
		announceChain = Promise.resolve();
		agentEnvFetches.clear();
		identityCache.clear();
		loggedOutMemo = null;
		set({ ...initialState });
	},
}));

// ============================================================================
// Identity resolution (memoized)
// ============================================================================

interface IdentityCacheEntry {
	fingerprint: string;
	identity: CredentialIdentity | null;
}

/** Per session id, so a replaced Session object does not invalidate the entry. */
const identityCache = new Map<string, IdentityCacheEntry>();

/** Stable string of the only four things that can change a session's identity. */
function identityFingerprint(
	toolType: string,
	sshRemoteId: string | null,
	homeDir: string,
	env: Record<string, string>
): string {
	const envPart = Object.keys(env)
		.sort()
		.map((key) => `${key}=${env[key]}`)
		.join(' ');
	return `${toolType}${sshRemoteId ?? ''}${homeDir}${envPart}`;
}

/**
 * The credential a session will present, or null when it cannot be resolved.
 *
 * Null has two causes, and both must stay null rather than falling back to a
 * local identity:
 *   - The home dir has not arrived yet, so a default config dir cannot be
 *     expanded.
 *   - SSH is enabled but names no remote. The user opted this agent into a
 *     different machine; reading the local credential and filing it under this
 *     session would describe a login the agent never presents. Same fail-closed
 *     rule as `buildTarget()` in `main/agents/auth/auth-startup.ts`.
 */
function resolveSessionIdentity(
	session: Session | undefined,
	state: ProviderAuthState
): CredentialIdentity | null {
	if (!session || !session.toolType) return null;
	if (!state.homeDir) return null;

	const sshConfig = session.sessionSshRemoteConfig;
	const sshEnabled = sshConfig?.enabled === true;
	const remoteId = typeof sshConfig?.remoteId === 'string' ? sshConfig.remoteId : '';
	if (sshEnabled && remoteId === '') return null;
	const sshRemoteId = sshEnabled ? remoteId : null;

	const env = mergeEffectiveEnv(state.agentEnvVars[session.toolType], session.customEnvVars);
	const fingerprint = identityFingerprint(session.toolType, sshRemoteId, state.homeDir, env);
	const cached = identityCache.get(session.id);
	if (cached && cached.fingerprint === fingerprint) return cached.identity;

	const identity = resolveCredentialIdentity({
		toolType: session.toolType,
		env,
		homeDir: state.homeDir,
		...(sshRemoteId ? { sshRemoteId } : {}),
	});
	identityCache.set(session.id, { fingerprint, identity });
	return identity;
}

/**
 * Resolve one session's identity without subscribing. For the reactive
 * `auth_expired` path, which has a session id and needs the key to mark.
 */
export function getIdentityForSession(sessionId: string): CredentialIdentity | null {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	return resolveSessionIdentity(session, useProviderAuthStore.getState());
}

/**
 * The credential an agent TYPE presents, for callers that have no Session.
 *
 * The wizard is why this exists: it drives a provider before any agent has been
 * created, so an auth failure there has a real credential and nothing to hang it
 * on. Only the agent-level env applies (there is no session to override it), and
 * the result is not cached because these callers ask once, on an error.
 *
 * Fails closed on an unresolved home dir or an SSH remote that names nothing,
 * for the same reasons as {@link resolveSessionIdentity}.
 */
export function getIdentityForAgentType(
	toolType: string,
	sshRemoteId?: string | null
): CredentialIdentity | null {
	if (!toolType) return null;
	const state = useProviderAuthStore.getState();
	if (!state.homeDir) return null;

	const env = mergeEffectiveEnv(state.agentEnvVars[toolType], undefined);
	return resolveCredentialIdentity({
		toolType,
		env,
		homeDir: state.homeDir,
		...(sshRemoteId ? { sshRemoteId } : {}),
	});
}

/**
 * Every session presenting one credential, in Left Bar order.
 *
 * The counterpart to {@link getIdentityForSession}, and the list a repaired
 * login has to act on: a user who signs in once and still sees fourteen agents
 * wearing an error badge has not been helped. Unlike
 * {@link selectLoggedOutIdentities} this does not care what the snapshot says,
 * so it still answers after the login succeeded and the status flipped.
 */
export function getSessionsForIdentity(identityKey: string): Session[] {
	const state = useProviderAuthStore.getState();
	return useSessionStore
		.getState()
		.sessions.filter((session) => resolveSessionIdentity(session, state)?.key === identityKey);
}

// ============================================================================
// Reactive marking (the `auth_expired` path)
// ============================================================================

/**
 * What an `auth_expired` failure means for each {@link CredentialKind}.
 *
 * Only an `oauth` credential can be `logged-out`, because that is the only kind
 * a login flow repairs. Everything else is recorded as `unsupported`: the
 * credential is genuinely broken, but sending the user to `claude auth login`
 * for a revoked API key or a gateway operator's outage wastes their time on a
 * command that cannot help. The status carries the remedy; the detail carries
 * the explanation.
 */
function authFailureFor(
	identity: CredentialIdentity,
	message: string
): { status: AuthFailureStatus; detail: string } {
	const trimmed = message.trim();
	switch (identity.kind) {
		case 'oauth':
			return { status: 'logged-out', detail: trimmed };
		case 'api-key':
			return {
				status: 'unsupported',
				detail: `${identity.envVarName ?? 'API key'} was rejected. Update the key; signing in cannot fix it. ${trimmed}`,
			};
		case 'gateway':
			return {
				status: 'unsupported',
				detail: `${identity.label} rejected the credential. This gateway is not Anthropic, so signing in cannot fix it. ${trimmed}`,
			};
		case 'cloud-provider':
			return {
				status: 'unsupported',
				detail: `${identity.label} credentials were rejected. They come from the cloud SDK chain, not from the agent CLI. ${trimmed}`,
			};
		default:
			return {
				status: 'unsupported',
				detail: `${identity.label} reported an auth failure with no known login flow. ${trimmed}`,
			};
	}
}

/**
 * Mark the credential behind one agent as failed, from a live `auth_expired`.
 *
 * This is the reactive half of the identity model: the agent that failed is one
 * of possibly fifteen presenting the same login, and marking the IDENTITY makes
 * the other fourteen show the problem before their next prompt burns.
 *
 * Hydrates first, since identity resolution needs the home dir and the
 * agent-level env, and an error can arrive before any UI has mounted. Never
 * throws and never rejects - an unmarkable identity costs a badge, and this runs
 * alongside error handling that must not be disturbed.
 */
export async function markSessionAuthFailure(
	sessionId: string,
	message: string
): Promise<ProviderAuthSnapshot | null> {
	try {
		await useProviderAuthStore.getState().hydrate();
		const identity = getIdentityForSession(sessionId);
		if (!identity) return null;
		const { status, detail } = authFailureFor(identity, message);
		return await useProviderAuthStore.getState().markIdentityAuthFailure({
			identity,
			status,
			detail,
			source: 'error-pattern',
		});
	} catch (error) {
		logger.warn('Failed to mark session auth failure', LOG_CONTEXT, {
			sessionId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * The session-free counterpart of {@link markSessionAuthFailure}, for a failure
 * observed against an agent TYPE (the wizard runs a provider before any agent
 * exists).
 *
 * Returns the identity rather than the snapshot, because the caller's next move
 * is to open the recovery modal on it. Marking first is what makes that possible:
 * the modal resolves its identity out of the snapshot map, so a credential that
 * has never been probed has to be recorded before it can be repaired.
 */
export async function markAgentTypeAuthFailure(
	toolType: string,
	sshRemoteId: string | null,
	message: string
): Promise<CredentialIdentity | null> {
	try {
		await useProviderAuthStore.getState().hydrate();
		const identity = getIdentityForAgentType(toolType, sshRemoteId);
		if (!identity) return null;
		const { status, detail } = authFailureFor(identity, message);
		await useProviderAuthStore.getState().markIdentityAuthFailure({
			identity,
			status,
			detail,
			source: 'error-pattern',
		});
		return identity;
	} catch (error) {
		logger.warn('Failed to mark agent auth failure', LOG_CONTEXT, {
			toolType,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

// ============================================================================
// Selectors
// ============================================================================

/**
 * The snapshot for the credential a session presents, or null when the session
 * has no resolvable identity or nothing has been stored for it yet.
 *
 * Returns the stored object by reference, so a subscriber only re-renders when
 * that identity's record actually changes.
 */
export const selectAuthSnapshotForSession =
	(sessionId: string) =>
	(state: ProviderAuthState): ProviderAuthSnapshot | null => {
		const session = selectSessionById(sessionId)(useSessionStore.getState());
		const identity = resolveSessionIdentity(session, state);
		if (!identity) return null;
		return state.snapshots[identity.key] ?? null;
	};

/**
 * The credential a session presents, or null when it has none Maestro can
 * resolve (no home dir yet, or SSH is on with no remote chosen).
 *
 * The subscribing counterpart to {@link getIdentityForSession}. Reference-stable
 * through the fingerprint cache in `resolveSessionIdentity`, so a subscriber
 * re-renders only when the agent's env, host, or provider actually changes.
 */
export const selectIdentityForSession =
	(sessionId: string) =>
	(state: ProviderAuthState): CredentialIdentity | null => {
		const session = selectSessionById(sessionId)(useSessionStore.getState());
		return resolveSessionIdentity(session, state);
	};

/** Cached result of {@link selectLoggedOutIdentities}, for reference stability. */
let loggedOutMemo: { signature: string; value: BlockedIdentity[] } | null = null;

/**
 * Every identity currently `logged-out`, each with the agents it blocks.
 *
 * Reference-stable: an unrelated session update (a log line landing) recomputes
 * the list but returns the previous array when the answer is unchanged, which is
 * what keeps zustand's `Object.is` comparison from re-rendering every subscriber
 * on every stdout chunk.
 */
export function selectLoggedOutIdentities() {
	return (state: ProviderAuthState): BlockedIdentity[] => {
		const sessions = useSessionStore.getState().sessions;
		const byKey = new Map<string, BlockedIdentity>();

		for (const session of sessions) {
			const identity = resolveSessionIdentity(session, state);
			if (!identity) continue;
			const snapshot = state.snapshots[identity.key];
			if (!snapshot || snapshot.status !== 'logged-out') continue;
			const existing = byKey.get(identity.key);
			if (existing) existing.sessionIds.push(session.id);
			else byKey.set(identity.key, { identity, snapshot, sessionIds: [session.id] });
		}

		const value = Array.from(byKey.values());
		const signature = value
			.map((entry) => `${entry.identity.key}:${entry.sessionIds.join(',')}`)
			.join('|');
		if (loggedOutMemo && loggedOutMemo.signature === signature) return loggedOutMemo.value;
		loggedOutMemo = { signature, value };
		return value;
	};
}

// ============================================================================
// Startup announcement (one toast per newly-discovered logged-out identity)
// ============================================================================

/** Agents named in the toast body before it switches to "and N more". */
const MAX_NAMED_AGENTS = 4;

/**
 * Whether a toast has a reader right now.
 *
 * Two existing gates, no new concept:
 *   - `window.maestro` absent means there is no desktop bridge (a headless CLI
 *     run, a test that stubbed nothing), so nothing is on screen to read it.
 *   - `defaultDuration === -1` is the app's toast kill switch. `notifyToast`
 *     honors it for the visible queue but still fires audio and the OS
 *     notification, and an unattended 3am Cue run must not get either from a
 *     login the user cannot come and fix.
 */
function canAnnounce(): boolean {
	if (typeof window === 'undefined' || !window.maestro) return false;
	return useNotificationStore.getState().config.defaultDuration !== -1;
}

/** "Alpha", "Alpha and Beta", "Alpha, Beta, Gamma, Delta and 8 more". */
function describeBlockedAgents(sessionIds: string[]): string {
	const sessions = useSessionStore.getState().sessions;
	const names = sessionIds
		.map((id) => sessions.find((s) => s.id === id)?.name)
		.filter((name): name is string => Boolean(name));
	if (names.length === 0) return 'Agents using this account are blocked until you sign in again.';
	if (names.length === 1) return `${names[0]} is blocked until you sign in again.`;

	const shown = names.slice(0, MAX_NAMED_AGENTS);
	const rest = names.length - shown.length;
	const list =
		rest > 0
			? `${shown.join(', ')} and ${rest} more`
			: `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
	return `${names.length} agents are blocked until you sign in again: ${list}.`;
}

/**
 * Serializes announcement passes. Two writes landing back to back would
 * otherwise both read the announced map before either wrote to it, and the user
 * would get the same toast twice.
 */
let announceChain: Promise<void> = Promise.resolve();

/** Queue an announcement pass. Fire-and-forget; failures are swallowed. */
function scheduleAnnouncement(): void {
	announceChain = announceChain.then(() => announceLoggedOutIdentities()).catch(() => {});
}

/**
 * Fire one toast per logged-out identity the user has not been told about yet.
 *
 * Per IDENTITY, never per agent: fifteen agents on one dead Anthropic login are
 * one problem and get one toast, whose body names the agents it costs. The toast
 * is sticky and click-to-act - this phase surfaces the state and waits, it never
 * opens a terminal or steals focus on its own.
 *
 * Idempotent. Safe to call on every snapshot write; only a key that is newly
 * logged out produces anything.
 */
export async function announceLoggedOutIdentities(): Promise<void> {
	if (!canAnnounce()) return;
	await useProviderAuthStore.getState().hydrate();
	// Identity keys computed without the agent-level env are the WRONG keys, so
	// wait for the in-flight fetches rather than announcing under a key that
	// matches nothing main stored.
	await Promise.all(Array.from(agentEnvFetches.values())).catch(() => {});

	const state = useProviderAuthStore.getState();
	const blocked = selectLoggedOutIdentities()(state);
	const announced = state.announcedIdentityKeys;

	// Rebuild rather than add: an identity that came back is forgotten here, so a
	// later logout of the same account is a new event and announces again.
	const next: Record<string, true> = {};
	for (const entry of blocked) next[entry.identity.key] = true;
	const fresh = blocked.filter((entry) => !announced[entry.identity.key]);

	const changed = fresh.length > 0 || Object.keys(next).length !== Object.keys(announced).length;
	// Write the map BEFORE the toasts, so a pass queued by anything a toast
	// touches cannot see these keys as still un-announced.
	if (changed) useProviderAuthStore.setState({ announcedIdentityKeys: next });

	for (const entry of fresh) {
		const { identity } = entry;
		notifyToast({
			// Orange, not red: nothing crashed and nothing was lost. An account
			// needs the user, which is more than a heads-up and less than a failure.
			color: 'orange',
			// A login the user never sees is a login they discover by burning a
			// prompt, so this one waits for a click rather than timing out.
			dismissible: true,
			title: `${getAgentDisplayName(identity.provider)} (${identity.label}) is signed out`,
			message: describeBlockedAgents(entry.sessionIds),
			// Data-driven, not a callback: the recovery flow is opened by kind, so
			// this survives the bridge and Phase 04 supplies the listener.
			clickAction: { kind: 'provider-auth-recovery', identityKey: identity.key },
		});
	}
}

// ============================================================================
// Non-React access
// ============================================================================

export function getProviderAuthState(): ProviderAuthState {
	return useProviderAuthStore.getState();
}

/**
 * Actions for call sites outside React (the agent error listener, mostly).
 */
export function getProviderAuthActions(): Pick<
	ProviderAuthState,
	| 'hydrate'
	| 'applyChange'
	| 'markIdentityAuthFailure'
	| 'markIdentityLoggedOut'
	| 'refreshIdentity'
	| 'refreshAllIdentities'
	| 'setSnapshots'
> {
	const state = useProviderAuthStore.getState();
	return {
		hydrate: state.hydrate,
		applyChange: state.applyChange,
		markIdentityAuthFailure: state.markIdentityAuthFailure,
		markIdentityLoggedOut: state.markIdentityLoggedOut,
		refreshIdentity: state.refreshIdentity,
		refreshAllIdentities: state.refreshAllIdentities,
		setSnapshots: state.setSnapshots,
	};
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * The auth snapshot for one agent, hydrating the store on first use so a
 * render site does not have to wire the IPC itself.
 */
export function useSessionAuthSnapshot(sessionId: string): ProviderAuthSnapshot | null {
	useHydrateProviderAuth();
	return useProviderAuthStore(selectAuthSnapshotForSession(sessionId));
}

/**
 * The credential one agent presents, hydrating the store on first use.
 *
 * Distinct from {@link useSessionAuthSnapshot}: an agent that has never been
 * probed has no snapshot but still has an identity, and the identity is what
 * decides which remedy to offer for an `auth_expired` error.
 */
export function useSessionIdentity(sessionId: string): CredentialIdentity | null {
	useHydrateProviderAuth();
	return useProviderAuthStore(selectIdentityForSession(sessionId));
}

/** Every logged-out identity and the agents each one blocks. Hydrates on first use. */
export function useLoggedOutIdentities(): BlockedIdentity[] {
	useHydrateProviderAuth();
	return useProviderAuthStore(selectLoggedOutIdentities());
}

/**
 * Trigger the one-time hydration from an effect rather than a render body, so a
 * double-invoked render in StrictMode cannot fire the IPC during render. The
 * `hydratePromise` guard makes repeated calls free.
 */
function useHydrateProviderAuth(): void {
	const loaded = useProviderAuthStore((s) => s.loaded);
	useEffect(() => {
		if (!loaded) void useProviderAuthStore.getState().hydrate();
	}, [loaded]);
}
