/**
 * @file plugin-session-grants.test.ts
 * @description Security tests for host-enforced per-session grants. The
 * contract: a plugin declaring the `granted-sessions` scope keyword may
 * dispatch to, and read the History of, ONLY the sessions it created through
 * `sessions.create` or that the user approved through `sessions.requestAccess`.
 *
 * Drives the REAL sealed `AuthorizationStore` (with fakes for the seal and the
 * credential-store anchor, like authorization-ledger.test.ts) so the grant set
 * is exercised through the same persistence, epoch, and broker path production
 * uses - a fake grant store would prove nothing about whether a grant survives
 * a restart or whether the broker denies a revoked one. The host-owned access
 * confirmation is an injected dependency, so no test opens a window.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	AuthorizationStore,
	type Anchor,
	type AnchorStore,
	type AuthIdentity,
	type SealProvider,
} from '../../../main/plugins/authorization-ledger';
import {
	PluginSessionGrants,
	configurePluginSessionGrants,
	grantSession,
	grantedSessions,
	isSessionGranted,
	resetPluginSessionGrants,
	revokeSession,
	usesSessionGrants,
} from '../../../main/plugins/plugin-session-grants';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import { ActionGuard } from '../../../main/plugins/action-guard';
import { PluginKvStore } from '../../../main/plugins/plugin-kv-store';
import { PluginEventBusImpl } from '../../../main/plugins/plugin-event-bus';
import {
	GRANTED_SESSIONS_SCOPE,
	grantsFromRequests,
	parsePermissions,
	type PermissionRequest,
} from '../../../shared/plugins/permissions';
import {
	buildHostCallHandlers,
	type HostHandlerDeps,
	type PluginSessionMetadata,
} from '../../../main/plugins/plugin-host-handlers';

const PLUGIN = 'maestro-kanban';
const OTHER = 'plain-plugin';
const IDENTITY: AuthIdentity = {
	contentHash: 'hash',
	signatureStatus: 'trusted',
	signerKey: 'key',
};

let tmpDir: string;
let ledgerPath: string;
let anchorHolder: { value: Anchor | null };
let kv: PluginKvStore;

/** Reversible "seal" with a marker, so foreign bytes fail to unseal. */
function fakeSeal(): SealProvider {
	const MARK = 'SEALED ';
	return {
		available: () => true,
		seal: (plaintext) => Buffer.from(MARK + plaintext, 'utf-8'),
		unseal: (blob) => {
			const s = blob.toString('utf-8');
			if (!s.startsWith(MARK)) throw new Error('not sealed by us');
			return s.slice(MARK.length);
		},
	};
}

/** In-memory anchor backed by an external holder - the OS credential vault,
 * which survives a reload of the store object. */
function fakeAnchor(holder: { value: Anchor | null }): AnchorStore {
	return {
		available: () => true,
		read: () => holder.value,
		write: (a) => {
			holder.value = { ...a };
		},
		clear: () => {
			holder.value = null;
		},
	};
}

function newStore(): AuthorizationStore {
	return new AuthorizationStore({
		seal: fakeSeal(),
		anchor: fakeAnchor(anchorHolder),
		ledgerPath,
	});
}

/** The kanban-shaped manifest request set: BOTH session-acting verbs carry the
 * keyword, which is the combination the board actually ships. */
const sessionGrantRequests: PermissionRequest[] = [
	{ capability: 'agents:dispatch', scope: GRANTED_SESSIONS_SCOPE },
	{ capability: 'transcripts:read', scope: GRANTED_SESSIONS_SCOPE },
];

/** An ordinary plugin: a named agent allowlist and a project path scope. */
const plainRequests: PermissionRequest[] = [
	{ capability: 'agents:dispatch', scope: 'sess-1' },
	{ capability: 'transcripts:read', scope: '/projects/app' },
];

/** Mint consent for both plugins, then install the grant set over the store. */
function installGrants(
	store: AuthorizationStore,
	sessions: PluginSessionMetadata[],
	audit?: (message: string) => void
): PluginSessionGrants {
	store.mint(PLUGIN, grantsFromRequests(sessionGrantRequests, 1), IDENTITY);
	store.mint(OTHER, grantsFromRequests(plainRequests, 1), IDENTITY);
	return configurePluginSessionGrants({
		authStore: store,
		getRequestedPermissions: (pluginId) =>
			pluginId === PLUGIN ? sessionGrantRequests : pluginId === OTHER ? plainRequests : undefined,
		sessionExists: (sessionId) => sessions.some((session) => session.id === sessionId),
		...(audit ? { audit } : {}),
	});
}

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-session-grants-'));
	ledgerPath = path.join(tmpDir, 'authorization.sealed');
	anchorHolder = { value: null };
	kv = new PluginKvStore({ baseDir: path.join(tmpDir, 'kv') });
});
afterEach(() => {
	resetPluginSessionGrants();
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const SESSIONS: PluginSessionMetadata[] = [
	{ id: 'sess-1', title: 'Kanban agent', projectPath: '/projects/app' },
	{ id: 'sess-2', title: 'Other agent', projectPath: '/projects/other' },
];

describe('the grant set itself', () => {
	it('reads the keyword off the MANIFEST, not the ledger', () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		expect(usesSessionGrants(PLUGIN)).toBe(true);
		expect(usesSessionGrants(OTHER)).toBe(false);
		expect(usesSessionGrants('never-installed')).toBe(false);
		// Granting REWRITES the dispatch grant's scope to real session ids, so the
		// keyword no longer appears in the ledger - the manifest is what still says
		// this plugin is governed by a grant set.
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		expect(store.readGrants(PLUGIN).find((g) => g.capability === 'agents:dispatch')?.scope).toBe(
			'sess-1'
		);
		expect(usesSessionGrants(PLUGIN)).toBe(true);
	});

	it('is NOT session-grant mode when only transcripts:read carries the keyword', () => {
		// The set is stored as the `agents:dispatch` allowlist scope, so a keyword on
		// `transcripts:read` alone names a set that cannot exist. Taking that as
		// "session-grant mode" had two bad endings: with no dispatch grant every
		// grantSession failed and the keyword covered nothing, and with an ORDINARY
		// dispatch allowlist the user's Settings-managed dispatch targets became the
		// transcript-read set that sessions.create then appended to. Here the plugin
		// holds exactly that ordinary allowlist (`sess-1`), so a true answer would
		// leak it as a grant set.
		const store = newStore();
		const transcriptsOnly: PermissionRequest[] = [
			{ capability: 'agents:dispatch', scope: 'sess-1' },
			{ capability: 'transcripts:read', scope: GRANTED_SESSIONS_SCOPE },
		];
		store.mint(PLUGIN, grantsFromRequests(transcriptsOnly, 1), IDENTITY);
		configurePluginSessionGrants({
			authStore: store,
			getRequestedPermissions: () => transcriptsOnly,
			sessionExists: (sessionId) => SESSIONS.some((s) => s.id === sessionId),
		});
		expect(usesSessionGrants(PLUGIN)).toBe(false);
		// The user's own dispatch allow list is never reported as a grant set...
		expect(grantedSessions(PLUGIN)).toEqual([]);
		expect(isSessionGranted(PLUGIN, 'sess-1')).toBe(false);
		// ...and nothing can be appended to it through the grant path.
		expect(grantSession(PLUGIN, 'sess-2', 'created')).toBe(false);
		expect(store.readGrants(PLUGIN).find((g) => g.capability === 'agents:dispatch')?.scope).toBe(
			'sess-1'
		);
	});

	it('falls back to the LEDGER when a manifest refresh drops the keyword mid-shutdown', () => {
		// The broker relaxes `transcripts:read`'s path match on the LEDGER carrying a
		// keyword scope, while the handler enforces `isSessionGranted` on the
		// MANIFEST requesting one. A refresh that drops the keyword while the old
		// sandbox is still draining made the manifest side false and the ledger side
		// true, so NEITHER check applied. The ledger fallback keeps both sides on the
		// same fact.
		const store = newStore();
		store.mint(PLUGIN, grantsFromRequests(sessionGrantRequests, 1), IDENTITY);
		let manifest: readonly PermissionRequest[] | undefined = sessionGrantRequests;
		configurePluginSessionGrants({
			authStore: store,
			getRequestedPermissions: () => manifest,
			sessionExists: (sessionId) => SESSIONS.some((s) => s.id === sessionId),
		});
		expect(usesSessionGrants(PLUGIN)).toBe(true);

		// The refreshed manifest no longer asks for the keyword, but the consented
		// ledger grant still carries it: stay in session-grant mode.
		manifest = [{ capability: 'transcripts:read', scope: '/projects/app' }];
		expect(usesSessionGrants(PLUGIN)).toBe(true);
		// A manifest gone entirely (the record is being torn down) is the same.
		manifest = undefined;
		expect(usesSessionGrants(PLUGIN)).toBe(true);
	});

	it('starts empty: a consented keyword grant covers no session', () => {
		installGrants(newStore(), SESSIONS);
		expect(grantedSessions(PLUGIN)).toEqual([]);
		expect(isSessionGranted(PLUGIN, 'sess-1')).toBe(false);
		expect(isSessionGranted(PLUGIN, 'sess-2')).toBe(false);
	});

	it('grants, revokes, and is idempotent, logging both with the source', () => {
		const audit = vi.fn();
		installGrants(newStore(), SESSIONS, audit);

		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('(created)'));
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('sess-1'));
		expect(isSessionGranted(PLUGIN, 'sess-1')).toBe(true);

		// Re-granting reports success but writes nothing new.
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		expect(audit).toHaveBeenCalledTimes(1);

		expect(grantSession(PLUGIN, 'sess-2', 'user-approved')).toBe(true);
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('(user-approved)'));
		expect(grantedSessions(PLUGIN)).toEqual(['sess-1', 'sess-2']);

		expect(revokeSession(PLUGIN, 'sess-1')).toBe(true);
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('session grant revoked'));
		expect(grantedSessions(PLUGIN)).toEqual(['sess-2']);
		expect(isSessionGranted(PLUGIN, 'sess-1')).toBe(false);
		// Revoking something that was never granted changes nothing.
		expect(revokeSession(PLUGIN, 'sess-1')).toBe(false);
	});

	it('never accepts an agent NAME in place of a session id', () => {
		installGrants(newStore(), SESSIONS);
		// 'Kanban agent' is session sess-1's NAME. A name is ambiguous and would be
		// resolved at dispatch time, which is the indirection the grant set removes.
		expect(grantSession(PLUGIN, 'Kanban agent', 'user-approved')).toBe(false);
		expect(grantSession(PLUGIN, 'sess-gone', 'created')).toBe(false);
		expect(grantedSessions(PLUGIN)).toEqual([]);
	});

	it('refuses to grant for a plugin that does not use session grants', () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		expect(grantSession(OTHER, 'sess-1', 'created')).toBe(false);
		expect(grantSession(OTHER, 'sess-2', 'user-approved')).toBe(false);
		// OTHER's own allowlist scope is untouched by the grant-set machinery, and
		// it is NOT reported as a grant set: that list is the user's Settings-managed
		// dispatch targets, so a plugin with no grant set has no granted sessions.
		expect(store.readGrants(OTHER).find((g) => g.capability === 'agents:dispatch')?.scope).toBe(
			'sess-1'
		);
		expect(grantedSessions(OTHER)).toEqual([]);
		expect(isSessionGranted(OTHER, 'sess-1')).toBe(false);
		expect(revokeSession(OTHER, 'sess-1')).toBe(false);
	});

	it('fails closed before a store is installed', () => {
		resetPluginSessionGrants();
		expect(usesSessionGrants(PLUGIN)).toBe(false);
		expect(isSessionGranted(PLUGIN, 'sess-1')).toBe(false);
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(false);
		expect(revokeSession(PLUGIN, 'sess-1')).toBe(false);
		expect(grantedSessions(PLUGIN)).toEqual([]);
	});

	it('persists grants across a reload of the authorization store', () => {
		installGrants(newStore(), SESSIONS);
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		expect(grantSession(PLUGIN, 'sess-2', 'user-approved')).toBe(true);

		// A brand-new store object over the same sealed file and the same anchor:
		// the restart path. Re-consent is NOT needed, and the set survives intact.
		const reloaded = newStore();
		const grants = configurePluginSessionGrants({
			authStore: reloaded,
			getRequestedPermissions: () => sessionGrantRequests,
			sessionExists: () => true,
		});
		expect(reloaded.isEnabled(PLUGIN)).toBe(true);
		expect(grants.grantedSessions(PLUGIN)).toEqual(['sess-1', 'sess-2']);
		expect(grants.isSessionGranted(PLUGIN, 'sess-2')).toBe(true);
	});

	it('loses the set when the capability is revoked (the ledger owns it)', () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		store.revoke(PLUGIN);
		expect(grantedSessions(PLUGIN)).toEqual([]);
		expect(isSessionGranted(PLUGIN, 'sess-1')).toBe(false);
	});
});

describe('the broker denies a non-granted session', () => {
	/** The production broker over the real ledger: what actually gates dispatch. */
	function brokerOver(store: AuthorizationStore): PermissionBroker {
		return new PermissionBroker({ getGrants: (pluginId) => store.readGrants(pluginId) });
	}

	it('denies dispatch to a non-granted session and allows a granted one', () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const broker = brokerOver(store);

		// Consented, but the set is empty: every dispatch is denied.
		expect(broker.authorize(PLUGIN, 'agents.dispatch', { agentId: 'sess-1' }).allowed).toBe(false);
		// The keyword must never be matchable as if it were a session id.
		expect(
			broker.authorize(PLUGIN, 'agents.dispatch', { agentId: GRANTED_SESSIONS_SCOPE }).allowed
		).toBe(false);

		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		expect(broker.authorize(PLUGIN, 'agents.dispatch', { agentId: 'sess-1' }).allowed).toBe(true);
		expect(broker.authorize(PLUGIN, 'agents.dispatch', { agentId: 'sess-2' }).allowed).toBe(false);

		// Revoked in Settings => denied on the very next call (grants are re-read).
		expect(revokeSession(PLUGIN, 'sess-1')).toBe(true);
		expect(broker.authorize(PLUGIN, 'agents.dispatch', { agentId: 'sess-1' }).allowed).toBe(false);
	});

	it('hands transcripts.read to the handler as a capability-held check', () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const broker = brokerOver(store);
		// A keyword grant has no path to compare, so the broker confirms only that
		// the capability is held - the handler enforces the concrete session.
		expect(
			broker.authorize(PLUGIN, 'transcripts.read', { projectPath: '/projects/other' }).allowed
		).toBe(true);
		expect(broker.authorize(PLUGIN, 'transcripts.read', {}).allowed).toBe(true);
		// A path-scoped plugin keeps today's strict project match.
		expect(
			broker.authorize(OTHER, 'transcripts.read', { projectPath: '/projects/app' }).allowed
		).toBe(true);
		expect(
			broker.authorize(OTHER, 'transcripts.read', { projectPath: '/projects/other' }).allowed
		).toBe(false);
	});

	it('does not relax the fs path verbs, which cannot carry the keyword', () => {
		const store = newStore();
		// A forged ledger entry: even if `fs:read` somehow carried the keyword (the
		// manifest parser rejects it), it must not become a capability-held check.
		store.mint(
			'forged',
			grantsFromRequests([{ capability: 'fs:read', scope: GRANTED_SESSIONS_SCOPE }], 1),
			IDENTITY
		);
		const broker = brokerOver(store);
		expect(broker.authorize('forged', 'fs.read', { path: '/etc/passwd' }).allowed).toBe(false);
	});
});

describe('sessions.requestAccess', () => {
	function handlersFor(
		store: AuthorizationStore,
		over: Partial<HostHandlerDeps> = {}
	): { handlers: ReturnType<typeof buildHostCallHandlers>; confirm: ReturnType<typeof vi.fn> } {
		const confirm = vi.fn(async () => true);
		const deps: HostHandlerDeps = {
			broker: new PermissionBroker({ getGrants: (pluginId) => store.readGrants(pluginId) }),
			actionGuard: new ActionGuard(),
			kvStore: kv,
			eventBus: new PluginEventBusImpl({ isPermitted: () => true, push: () => true }),
			egressGuard: { assertUrlAllowed: async () => {}, lookup: (() => {}) as never },
			settingsGet: () => null,
			settingsSet: vi.fn(),
			settingsDeleteNamespace: vi.fn(),
			sessionsList: () => SESSIONS,
			sessionsGet: (sessionId) => SESSIONS.find((s) => s.id === sessionId) ?? null,
			listAgents: () => [],
			runUiCommand: async () => true,
			readSessionTranscript: async () => [],
			assertTranscriptReadAllowed: () => {},
			auditTranscriptRead: () => {},
			isPluginTrusted: () => true,
			usesSessionGrants,
			isSessionGranted,
			grantSession,
			pluginDisplayName: () => 'Kanban Board',
			confirmSessionAccess: confirm,
			...over,
		};
		return { handlers: buildHostCallHandlers(deps), confirm };
	}

	it('is not registered at all without the host-owned confirmation', () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const { handlers } = handlersFor(store, { confirmSessionAccess: undefined });
		expect(handlers['sessions.requestAccess']).toBeUndefined();
	});

	it('grants with source user-approved when the user allows', async () => {
		const audit = vi.fn();
		const store = newStore();
		installGrants(store, SESSIONS, audit);
		const { handlers, confirm } = handlersFor(store);

		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).resolves.toEqual({ granted: true });
		// The confirmation names the plugin, the agent, and its project.
		expect(confirm).toHaveBeenCalledWith({
			pluginId: PLUGIN,
			pluginName: 'Kanban Board',
			sessionId: 'sess-2',
			sessionTitle: 'Other agent',
			projectPath: '/projects/other',
		});
		expect(isSessionGranted(PLUGIN, 'sess-2')).toBe(true);
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('(user-approved)'));
	});

	it('leaves a declined session ungranted and does not prompt again', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const { handlers, confirm } = handlersFor(store, { confirmSessionAccess: async () => false });

		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).resolves.toEqual({ granted: false });
		expect(isSessionGranted(PLUGIN, 'sess-2')).toBe(false);
		void confirm;

		// A second ask for the same session is answered from the declined set: no
		// second dialog, so a denied board cannot nag on every click.
		const declining = vi.fn(async () => false);
		const { handlers: again } = handlersFor(store, { confirmSessionAccess: declining });
		await expect(
			again['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).resolves.toEqual({ granted: false });
		expect(declining).toHaveBeenCalledTimes(1);
		await expect(
			again['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).resolves.toEqual({ granted: false });
		expect(declining).toHaveBeenCalledTimes(1);
		// A DIFFERENT session is still askable.
		await expect(
			again['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-1' })
		).resolves.toEqual({ granted: false });
		expect(declining).toHaveBeenCalledTimes(2);
	});

	it('answers an already-granted session immediately, with no confirmation', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		const { handlers, confirm } = handlersFor(store);
		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-1' })
		).resolves.toEqual({ granted: true });
		expect(confirm).not.toHaveBeenCalled();
	});

	it('shows at most one confirmation per plugin at a time', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const gate = Promise.withResolvers<boolean>();
		const confirm = vi.fn(() => gate.promise);
		const { handlers } = handlersFor(store, { confirmSessionAccess: confirm });

		const first = handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-1' });
		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).rejects.toThrow(/already open/);
		expect(confirm).toHaveBeenCalledTimes(1);
		gate.resolve(true);
		await expect(first).resolves.toEqual({ granted: true });
		// With the first prompt settled, a second one may open.
		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).resolves.toEqual({ granted: true });
		expect(confirm).toHaveBeenCalledTimes(2);
	});

	it('rejects a plugin that does not use session grants, and a bad payload', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const { handlers, confirm } = handlersFor(store);
		await expect(
			handlers['sessions.requestAccess']!(OTHER, { sessionId: 'sess-1' })
		).rejects.toThrow(/granted-sessions/);
		await expect(handlers['sessions.requestAccess']!(PLUGIN, {})).rejects.toThrow(
			/sessionId is required/
		);
		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-1', prompt: 'rm -rf' })
		).rejects.toThrow(/closed schema/);
		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-gone' })
		).rejects.toThrow(/unknown sessionId/);
		expect(confirm).not.toHaveBeenCalled();
	});

	it('reports granted:false when the ledger refuses the write', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		// No consented dispatch grant to carry the set (revoked between the ask and
		// the answer): report honestly rather than claim a grant the broker denies.
		store.revoke(PLUGIN);
		const { handlers } = handlersFor(store);
		await expect(
			handlers['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).rejects.toThrow(/permission denied/);

		// And when the capability is held but `grantSession` is unwired.
		const fresh = newStore();
		installGrants(fresh, SESSIONS);
		const { handlers: unwired } = handlersFor(fresh, { grantSession: undefined });
		await expect(
			unwired['sessions.requestAccess']!(PLUGIN, { sessionId: 'sess-2' })
		).resolves.toEqual({ granted: false });
	});
});

describe('a session the plugin CREATED is granted', () => {
	/** The production integration site (`pluginSessionsCreate` in main/index.ts)
	 * writes the session to the store and then grants it, which is the order
	 * `sessionExists` depends on. Reproduce exactly that shape over the real grant
	 * set, so this covers the contract the host actually implements rather than a
	 * restatement of `grantSession`. The deps-wiring guard pins that index.ts
	 * still calls it this way. */
	/** `sessions.create` is its own consented capability, held alongside the two
	 * session-grant scopes. `mint` REPLACES a plugin's cap set, so re-mint the
	 * whole set with it appended rather than adding it on its own. */
	const withCreate = (
		store: AuthorizationStore,
		pluginId: string,
		requests: readonly PermissionRequest[]
	): void => {
		store.mint(
			pluginId,
			grantsFromRequests([...requests, { capability: 'sessions:create' }], 2),
			IDENTITY
		);
	};

	function handlersThatCreate(
		store: AuthorizationStore,
		sessions: PluginSessionMetadata[]
	): {
		handlers: ReturnType<typeof buildHostCallHandlers>;
		created: Array<{ params: Record<string, unknown>; pluginId: string }>;
		dispatch: ReturnType<typeof vi.fn>;
	} {
		const created: Array<{ params: Record<string, unknown>; pluginId: string }> = [];
		const dispatch = vi.fn(async () => ({ dispatched: true }));
		const handlers = buildHostCallHandlers({
			broker: new PermissionBroker({ getGrants: (pluginId) => store.readGrants(pluginId) }),
			actionGuard: new ActionGuard(),
			kvStore: kv,
			eventBus: new PluginEventBusImpl({ isPermitted: () => true, push: () => true }),
			egressGuard: { assertUrlAllowed: async () => {}, lookup: (() => {}) as never },
			settingsGet: () => null,
			settingsSet: vi.fn(),
			settingsDeleteNamespace: vi.fn(),
			sessionsList: () => sessions,
			sessionsGet: (sessionId) => sessions.find((s) => s.id === sessionId) ?? null,
			sessionsCreate: async (params, pluginId) => {
				created.push({ params, pluginId });
				const session: PluginSessionMetadata = {
					id: typeof params.id === 'string' ? params.id : 'generated',
					title: typeof params.title === 'string' ? params.title : 'Plugin Session',
					projectPath: '/projects/new',
				};
				// Store write FIRST, so the grant's `sessionExists` check can see it.
				sessions.push(session);
				if (usesSessionGrants(pluginId)) grantSession(pluginId, session.id, 'created');
				return session;
			},
			listAgents: () => [],
			runUiCommand: async () => true,
			readSessionTranscript: async () => [
				{
					id: 'h1',
					type: 'PROMPT',
					timestamp: 5,
					summary: 'started up',
					projectPath: '/projects/new',
					sessionId: 'sess-new',
				} as never,
			],
			assertTranscriptReadAllowed: () => {},
			auditTranscriptRead: () => {},
			isPluginTrusted: () => true,
			dispatchUnattendedAllowed: () => true,
			usesSessionGrants,
			isSessionGranted,
			grantSession,
			dispatch,
		});
		return { handlers, created, dispatch };
	}

	it('grants the new session with source created, and only that one', async () => {
		const audit = vi.fn();
		const store = newStore();
		const sessions = [...SESSIONS];
		installGrants(store, sessions, audit);
		withCreate(store, PLUGIN, sessionGrantRequests);
		const { handlers } = handlersThatCreate(store, sessions);

		// Nothing is granted before the create: the board sees sess-1 and sess-2 as
		// cards but may not touch either.
		expect(grantedSessions(PLUGIN)).toEqual([]);

		await expect(
			handlers['sessions.create']!(PLUGIN, { id: 'sess-new', title: 'Board agent' })
		).resolves.toMatchObject({ id: 'sess-new' });

		expect(grantedSessions(PLUGIN)).toEqual(['sess-new']);
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('(created)'));
		expect(audit).toHaveBeenCalledWith(expect.stringContaining('sess-new'));

		// The created session is immediately usable with no further confirmation...
		await expect(
			handlers['agents.dispatch']!(PLUGIN, { agentId: 'sess-new', prompt: 'hello' })
		).resolves.toEqual({ dispatched: true });
		await expect(
			handlers['transcripts.read']!(PLUGIN, { sessionId: 'sess-new', fields: ['summary'] })
		).resolves.toEqual([{ summary: 'started up' }]);
		// ...and creating one grants nothing else: the agents that were already
		// there are still off limits.
		await expect(
			handlers['agents.dispatch']!(PLUGIN, { agentId: 'sess-1', prompt: 'hello' })
		).rejects.toThrow(/permission denied/);
		await expect(
			handlers['transcripts.read']!(PLUGIN, { sessionId: 'sess-1', fields: ['summary'] })
		).rejects.toThrow(/is not granted to this plugin/);
	});

	it('uses the HOST-verified pluginId, so a forged one cannot self-grant', async () => {
		const store = newStore();
		const sessions = [...SESSIONS];
		installGrants(store, sessions, vi.fn());
		withCreate(store, PLUGIN, sessionGrantRequests);
		const { handlers, created } = handlersThatCreate(store, sessions);

		// A plugin claiming to be someone else in its own params: the handler
		// passes the caller identity it verified, and the params are just params.
		await expect(
			handlers['sessions.create']!(PLUGIN, { id: 'sess-new', pluginId: OTHER })
		).resolves.toMatchObject({ id: 'sess-new' });
		expect(created).toHaveLength(1);
		expect(created[0]!.pluginId).toBe(PLUGIN);
		expect(grantedSessions(PLUGIN)).toEqual(['sess-new']);
		// And nothing landed on the impersonated plugin.
		expect(grantedSessions(OTHER)).toEqual([]);
		expect(isSessionGranted(OTHER, 'sess-new')).toBe(false);
	});

	it('grants nothing for a plugin that does not use session grants', async () => {
		const store = newStore();
		const sessions = [...SESSIONS];
		installGrants(store, sessions);
		// OTHER needs the capability to reach the sink at all; its grant set stays
		// empty because it never asked to be governed by one.
		withCreate(store, OTHER, plainRequests);
		const { handlers } = handlersThatCreate(store, sessions);
		await expect(handlers['sessions.create']!(OTHER, { id: 'sess-new' })).resolves.toMatchObject({
			id: 'sess-new',
		});
		expect(grantedSessions(OTHER)).toEqual([]);
		expect(isSessionGranted(OTHER, 'sess-new')).toBe(false);
		// Its user-managed dispatch allow list is untouched by the create.
		expect(store.readGrants(OTHER).find((g) => g.capability === 'agents:dispatch')?.scope).toBe(
			'sess-1'
		);
	});
});

describe('revocation through the Settings allow list editor', () => {
	/** What `plugins:set-agent-allowlist` does after its own validation: re-mint
	 * the grant's scope from the ids the USER left selected. Driving
	 * `setAllowlistScope` directly is the honest unit here - the IPC handler adds
	 * only sender/flag/manifest checks on top, and those are not what a removed
	 * session's denial depends on. */
	const settingsEditSelection = (store: AuthorizationStore, members: readonly string[]): boolean =>
		store.setAllowlistScope(PLUGIN, 'agents:dispatch', members);

	it('removes a member, and the removed session is denied on the very next call', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		expect(grantSession(PLUGIN, 'sess-1', 'created')).toBe(true);
		expect(grantSession(PLUGIN, 'sess-2', 'user-approved')).toBe(true);

		const dispatch = vi.fn(async () => ({ dispatched: true }));
		const handlers = buildHostCallHandlers({
			broker: new PermissionBroker({ getGrants: (pluginId) => store.readGrants(pluginId) }),
			actionGuard: new ActionGuard(),
			kvStore: kv,
			eventBus: new PluginEventBusImpl({ isPermitted: () => true, push: () => true }),
			egressGuard: { assertUrlAllowed: async () => {}, lookup: (() => {}) as never },
			settingsGet: () => null,
			settingsSet: vi.fn(),
			settingsDeleteNamespace: vi.fn(),
			sessionsList: () => SESSIONS,
			sessionsGet: (sessionId) => SESSIONS.find((s) => s.id === sessionId) ?? null,
			listAgents: () => [],
			runUiCommand: async () => true,
			readSessionTranscript: async () => [
				{
					id: 'h1',
					type: 'PROMPT',
					timestamp: 5,
					summary: 'did a thing',
					projectPath: '/projects/other',
					sessionId: 'sess-2',
				} as never,
			],
			assertTranscriptReadAllowed: () => {},
			auditTranscriptRead: () => {},
			isPluginTrusted: () => true,
			dispatchUnattendedAllowed: () => true,
			usesSessionGrants,
			isSessionGranted,
			grantSession,
			dispatch,
		});

		// Granted: both verbs work.
		await expect(
			handlers['agents.dispatch']!(PLUGIN, { agentId: 'sess-2', prompt: 'hello' })
		).resolves.toEqual({ dispatched: true });
		await expect(
			handlers['transcripts.read']!(PLUGIN, { sessionId: 'sess-2', fields: ['summary'] })
		).resolves.toEqual([{ summary: 'did a thing' }]);

		// The user deselects sess-2 in Settings. No restart, no re-consent.
		expect(settingsEditSelection(store, ['sess-1'])).toBe(true);
		expect(grantedSessions(PLUGIN)).toEqual(['sess-1']);

		await expect(
			handlers['agents.dispatch']!(PLUGIN, { agentId: 'sess-2', prompt: 'hello' })
		).rejects.toThrow(/permission denied/);
		await expect(
			handlers['transcripts.read']!(PLUGIN, { sessionId: 'sess-2', fields: ['summary'] })
		).rejects.toThrow(/is not granted to this plugin/);
		expect(dispatch).toHaveBeenCalledTimes(1);

		// Clearing the whole selection is a valid lockdown short of a full revoke.
		expect(settingsEditSelection(store, [])).toBe(true);
		expect(grantedSessions(PLUGIN)).toEqual([]);
		await expect(
			handlers['agents.dispatch']!(PLUGIN, { agentId: 'sess-1', prompt: 'hello' })
		).rejects.toThrow(/permission denied/);
	});
});

describe('a plugin WITHOUT granted-sessions keeps its current behavior', () => {
	it('parses an ordinary allowlist and path scope unchanged', () => {
		const parsed = parsePermissions([
			{ capability: 'agents:dispatch', scope: 'sess-1,sess-2' },
			{ capability: 'transcripts:read', scope: '/projects/app' },
		]);
		expect(parsed.errors).toEqual([]);
		expect(parsed.requests).toEqual([
			{ capability: 'agents:dispatch', scope: 'sess-1,sess-2' },
			{ capability: 'transcripts:read', scope: '/projects/app' },
		]);
	});

	it('dispatches and reads by its own scopes, with the grant set inert', async () => {
		const store = newStore();
		installGrants(store, SESSIONS);
		const dispatch = vi.fn(async () => ({ dispatched: true }));
		const handlers = buildHostCallHandlers({
			broker: new PermissionBroker({ getGrants: (pluginId) => store.readGrants(pluginId) }),
			actionGuard: new ActionGuard(),
			kvStore: kv,
			eventBus: new PluginEventBusImpl({ isPermitted: () => true, push: () => true }),
			egressGuard: { assertUrlAllowed: async () => {}, lookup: (() => {}) as never },
			settingsGet: () => null,
			settingsSet: vi.fn(),
			settingsDeleteNamespace: vi.fn(),
			sessionsList: () => SESSIONS,
			sessionsGet: (sessionId) => SESSIONS.find((s) => s.id === sessionId) ?? null,
			listAgents: () => [],
			runUiCommand: async () => true,
			readSessionTranscript: async () => [
				{
					id: 'h1',
					type: 'PROMPT',
					timestamp: 5,
					summary: 'did a thing',
					projectPath: '/projects/app',
					sessionId: 'sess-1',
				} as never,
			],
			assertTranscriptReadAllowed: () => {},
			auditTranscriptRead: () => {},
			isPluginTrusted: () => true,
			dispatchUnattendedAllowed: () => true,
			usesSessionGrants,
			isSessionGranted,
			grantSession,
			dispatch,
		});
		// OTHER holds `agents:dispatch` scoped to the NAMED agent sess-1 and
		// `transcripts:read` scoped to /projects/app. Neither is in the grant set,
		// and both still work exactly as before.
		expect(isSessionGranted(OTHER, 'sess-1')).toBe(false);
		await expect(
			handlers['agents.dispatch']!(OTHER, { agentId: 'sess-1', prompt: 'hello' })
		).resolves.toEqual({ dispatched: true });
		await expect(
			handlers['transcripts.read']!(OTHER, { sessionId: 'sess-1', fields: ['summary'] })
		).resolves.toEqual([{ summary: 'did a thing' }]);
		// Its own scopes still bound it.
		await expect(
			handlers['agents.dispatch']!(OTHER, { agentId: 'sess-2', prompt: 'hello' })
		).rejects.toThrow(/permission denied/);
		await expect(
			handlers['transcripts.read']!(OTHER, { sessionId: 'sess-2', fields: ['summary'] })
		).rejects.toThrow(/permission denied/);
	});
});
