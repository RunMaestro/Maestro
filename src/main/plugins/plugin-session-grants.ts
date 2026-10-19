/**
 * Host-enforced per-session grants for plugins (main process).
 *
 * A plugin that declares the `granted-sessions` scope keyword (see
 * `GRANTED_SESSIONS_SCOPE` in `shared/plugins/permissions.ts`) may dispatch to,
 * and read the History of, ONLY the sessions the HOST has granted it:
 *
 *  - `'created'`       a session the plugin itself made through `sessions.create`
 *  - `'user-approved'` a session the user approved in a one-time, host-owned
 *                      confirmation raised by `sessions.requestAccess`
 *
 * Nothing else. The plugin can see every agent as metadata (`sessions:read`),
 * but it cannot message or read one until it is in this set. The plugin never
 * decides membership; the host and the user do.
 *
 * There is deliberately NO new storage here. The member set IS the
 * `agents:dispatch` grant's allowlist scope in the sealed authorization ledger,
 * written through `AuthorizationStore.setAllowlistScope`, which buys the whole
 * existing security posture for free:
 *  - sealed at rest, epoch-bumped, anti-rollback, session-only fallback;
 *  - checked by the permission broker on EVERY dispatch (exact set membership);
 *  - already editable by the user in Settings (`plugins:set-agent-allowlist` ->
 *    the `AgentDispatchAllowlist` editor), so revocation needs no new UI;
 *  - dropped when the capability is revoked or the plugin is uninstalled.
 *
 * Because the set lives in the dispatch grant, a plugin must hold a consented
 * `agents:dispatch` grant for a grant set to exist at all; `grantSession`
 * returns false when it does not (the user must approve the capability at the
 * consent window first). `transcripts:read` reads the same set, and the
 * manifest parser requires the keyword on `agents:dispatch` whenever
 * `transcripts:read` declares it, so the set it reads always exists.
 *
 * Two predicates, deliberately not one:
 *  - `usesSessionGrants` gates ENFORCEMENT (does the handler check the set?) and
 *    is broad: the manifest's `agents:dispatch` keyword, or ANY session-grant
 *    ledger grant carrying the keyword. It mirrors what the broker relaxes, so
 *    no state exists where the broker drops its scope match and the handler
 *    declines to check the set.
 *  - `holdsGrantSetKeyword` gates MUTATION (may the host ADD a member?) and is
 *    strict: the keyword must be on `agents:dispatch`, because that grant's
 *    allowlist scope IS the storage. This is what keeps `grantSession` away from
 *    an ordinary, user-managed dispatch allow list.
 * Both prefer the MANIFEST, because the host rewrites the grant's scope to real
 * session ids as it grants them and the keyword only survives in the request,
 * and both fall back to the ledger so a manifest refresh cannot change the
 * answer underneath a still-draining sandbox.
 */

import {
	GRANTED_SESSIONS_SCOPE,
	capabilitySupportsSessionGrants,
	isSessionGrantScope,
	parseAllowlistScope,
	type PermissionGrant,
	type PluginCapability,
} from '../../shared/plugins/permissions';

/** Why a session is in a plugin's grant set (audited, never guessed). */
export type SessionGrantSource = 'created' | 'user-approved';

/** The capability whose allowlist scope stores the grant set. */
const GRANT_SET_CAPABILITY: PluginCapability = 'agents:dispatch';

/** The slice of `AuthorizationStore` the grant set needs. Narrowed to a
 * structural type so tests can drive it with a fake and the module never
 * reaches for the ledger singleton itself. */
export interface SessionGrantAuthStore {
	readGrants(pluginId: string): PermissionGrant[];
	setAllowlistScope(
		pluginId: string,
		capability: PluginCapability,
		members: readonly string[]
	): boolean;
}

export interface PluginSessionGrantsDeps {
	/** The sealed authorization ledger (or a narrowed fake in tests). */
	authStore: SessionGrantAuthStore;
	/** The plugin's MANIFEST-requested permissions. The keyword lives here. */
	getRequestedPermissions: (
		pluginId: string
	) => readonly { capability: PluginCapability; scope?: string }[] | undefined;
	/** Does a session with this id exist RIGHT NOW? Only a live session id may be
	 * granted - never an agent name, never a stale id. */
	sessionExists: (sessionId: string) => boolean;
	/** Plugin audit sink. Every grant and revoke is logged with its source. */
	audit?: (message: string) => void;
}

/**
 * The grant set. Reads the ledger live on every question so a Settings revoke
 * is denied on the very next dispatch or History read rather than at the next
 * restart.
 */
export class PluginSessionGrants {
	constructor(private readonly deps: PluginSessionGrantsDeps) {}

	/** Is this plugin in session-grant mode? True => the host's grant set governs
	 * its dispatch and History reach, replacing the ordinary scope match.
	 *
	 * The question is asked of `agents:dispatch` SPECIFICALLY, not of any
	 * session-grant-capable capability, because that is the one capability whose
	 * allowlist scope stores the set (`GRANT_SET_CAPABILITY`). A keyword on
	 * `transcripts:read` alone used to turn the mode on with no set behind it:
	 * either `grantSession` failed on every call (no dispatch grant to carry the
	 * members) or, worse, `grantedSessions` returned the user's own
	 * Settings-managed dispatch allowlist as the transcript-read set and
	 * `sessions.create` appended to that user-owned list. `parsePermissions` now
	 * rejects that manifest outright, and this check is the matching runtime half.
	 */
	usesSessionGrants(pluginId: string): boolean {
		if (this.holdsGrantSetKeyword(pluginId)) return true;
		// Fail-closed fallback, because the broker and this predicate are two halves
		// of one check and must never disagree. The broker relaxes a path-scoped
		// verb's scope match when THAT verb's own LEDGER grant carries the keyword
		// (`hasSessionGrantScope` is per-capability), and leaves enforcement to the
		// handler, which asks this. Any state where the broker relaxes and this
		// answers false is a hole: neither layer checks the set, and the plugin
		// reads any session's transcripts.
		//
		// Two such states exist, which is why this is deliberately broader than
		// `holdsGrantSetKeyword`:
		//  - a manifest refresh that drops the keyword while the old sandbox is
		//    still draining (the manifest says no, the ledger still says yes);
		//  - any moment after the first grant, since `grantSession` rewrites only
		//    the `agents:dispatch` scope to real ids and never touches the
		//    `transcripts:read` grant, so that one keeps its keyword forever.
		// So mirror the broker exactly: ANY session-grant-capable ledger grant
		// carrying the keyword puts this plugin in enforcement mode.
		return this.deps.authStore
			.readGrants(pluginId)
			.some(
				(grant) =>
					capabilitySupportsSessionGrants(grant.capability) && isSessionGrantScope(grant.scope)
			);
	}

	/**
	 * May the HOST hold a grant set for this plugin at all - that is, is the
	 * keyword on `agents:dispatch`, the one capability whose allowlist scope
	 * stores the members?
	 *
	 * Kept separate from `usesSessionGrants` because the two answer different
	 * questions and must not be merged. `usesSessionGrants` gates ENFORCEMENT and
	 * is broad on purpose (see above); this gates MUTATION and is strict. Widening
	 * the mutation gate the same way would let a plugin holding the keyword on
	 * `transcripts:read` over an ORDINARY dispatch allowlist have `grantSession`
	 * append to that list, which is the user's own Settings-managed set of dispatch
	 * targets and not a host-held grant set at all.
	 *
	 * The manifest is preferred for the same reason as above (granting rewrites the
	 * ledger scope to real ids, so the keyword only survives in the request), with
	 * the ledger as the same fail-closed fallback.
	 */
	private holdsGrantSetKeyword(pluginId: string): boolean {
		const requested = this.deps.getRequestedPermissions(pluginId) ?? [];
		if (
			requested.some(
				(request) =>
					request.capability === GRANT_SET_CAPABILITY && isSessionGrantScope(request.scope)
			)
		) {
			return true;
		}
		return this.deps.authStore
			.readGrants(pluginId)
			.some(
				(grant) => grant.capability === GRANT_SET_CAPABILITY && isSessionGrantScope(grant.scope)
			);
	}

	/**
	 * The session ids currently granted to this plugin (order-stable, keyword
	 * excluded - `parseAllowlistScope` drops it).
	 *
	 * EMPTY for a plugin that does not use session grants, even though its
	 * `agents:dispatch` grant carries an allowlist of agent ids: that list is the
	 * user's Settings-managed dispatch targets, NOT a host-held grant set, and
	 * reporting it here would answer "granted" for a plugin that has no grant set
	 * at all.
	 */
	grantedSessions(pluginId: string): readonly string[] {
		if (!this.usesSessionGrants(pluginId)) return [];
		const grant = this.deps.authStore
			.readGrants(pluginId)
			.find((candidate) => candidate.capability === GRANT_SET_CAPABILITY);
		if (!grant) return [];
		return parseAllowlistScope(grant.scope) ?? [];
	}

	/** Is this exact session id granted to this plugin? */
	isSessionGranted(pluginId: string, sessionId: string): boolean {
		if (typeof sessionId !== 'string' || sessionId === '') return false;
		return this.grantedSessions(pluginId).includes(sessionId);
	}

	/**
	 * Add one session to the plugin's grant set. Returns false (and grants
	 * nothing) when the plugin does not use session grants, when the id names no
	 * live session, or when the plugin holds no consented `agents:dispatch` grant
	 * to carry the set. Idempotent: re-granting an already-granted session is a
	 * no-op that reports success without a second ledger write or audit line.
	 */
	grantSession(pluginId: string, sessionId: string, source: SessionGrantSource): boolean {
		// The STRICT gate, not `usesSessionGrants`: adding a member writes the
		// `agents:dispatch` allowlist scope, so the keyword has to be on that
		// capability. A plugin in enforcement mode only because its
		// `transcripts:read` grant carries the keyword has no host-held set, and
		// appending here would edit the user's own dispatch allow list.
		if (!this.holdsGrantSetKeyword(pluginId)) return false;
		// Only an existing SESSION ID, never an agent name: a name is ambiguous and
		// `dispatchPromptToSession` would resolve it at call time, which is exactly
		// the indirection a grant set exists to remove.
		if (!this.deps.sessionExists(sessionId)) return false;
		const current = this.grantedSessions(pluginId);
		if (current.includes(sessionId)) return true;
		const members = [...current, sessionId];
		if (!this.deps.authStore.setAllowlistScope(pluginId, GRANT_SET_CAPABILITY, members)) {
			return false;
		}
		this.deps.audit?.(
			`session grant: "${pluginId}" may now message and read session ${sessionId} (${source}); ` +
				`set is ${members.length} session(s)`
		);
		return true;
	}

	/**
	 * Remove one session from the plugin's grant set. Returns false when the
	 * session was not granted (nothing to revoke) or the ledger write fails. The
	 * very next dispatch and History read for that session are denied, because
	 * both re-read the live grant.
	 */
	revokeSession(pluginId: string, sessionId: string): boolean {
		// `grantedSessions` is empty for a plugin with no grant set, so this never
		// edits an ordinary plugin's user-managed dispatch allow list.
		const current = this.grantedSessions(pluginId);
		if (!current.includes(sessionId)) return false;
		const members = current.filter((member) => member !== sessionId);
		if (!this.deps.authStore.setAllowlistScope(pluginId, GRANT_SET_CAPABILITY, members)) {
			return false;
		}
		this.deps.audit?.(
			`session grant revoked: "${pluginId}" can no longer message or read session ${sessionId}; ` +
				`set is ${members.length} session(s)`
		);
		return true;
	}
}

/**
 * The live grant set, installed once by the main-process integration site. The
 * module-level functions below are the host's API; they fail CLOSED when no
 * store is installed, so a partially wired host denies rather than grants.
 */
let active: PluginSessionGrants | null = null;

export function configurePluginSessionGrants(deps: PluginSessionGrantsDeps): PluginSessionGrants {
	active = new PluginSessionGrants(deps);
	return active;
}

/** Test/shutdown seam: forget the installed store. */
export function resetPluginSessionGrants(): void {
	active = null;
}

/** Does this plugin's manifest request `granted-sessions`? False when no store
 * is installed (nothing is wired, so nothing is session-granted). */
export function usesSessionGrants(pluginId: string): boolean {
	return active?.usesSessionGrants(pluginId) ?? false;
}

/** Grant one existing session to a plugin, recording why. */
export function grantSession(
	pluginId: string,
	sessionId: string,
	source: SessionGrantSource
): boolean {
	return active?.grantSession(pluginId, sessionId, source) ?? false;
}

/** Remove one session from a plugin's grant set. */
export function revokeSession(pluginId: string, sessionId: string): boolean {
	return active?.revokeSession(pluginId, sessionId) ?? false;
}

/** Is this exact session granted to this plugin? Fail-closed when unwired. */
export function isSessionGranted(pluginId: string, sessionId: string): boolean {
	return active?.isSessionGranted(pluginId, sessionId) ?? false;
}

/** The session ids currently granted to a plugin. */
export function grantedSessions(pluginId: string): readonly string[] {
	return active?.grantedSessions(pluginId) ?? [];
}

export { GRANTED_SESSIONS_SCOPE };
