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
 * `usesSessionGrants` prefers the MANIFEST, because the host rewrites the
 * grant's scope to real session ids as it grants them and the keyword only
 * survives in the manifest request. It falls back to the ledger so a manifest
 * refresh cannot switch the mode off underneath a still-draining sandbox; see
 * the method for why that window mattered.
 */

import {
	GRANTED_SESSIONS_SCOPE,
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
		const requested = this.deps.getRequestedPermissions(pluginId) ?? [];
		const manifestUses = requested.some(
			(request) => request.capability === GRANT_SET_CAPABILITY && isSessionGrantScope(request.scope)
		);
		if (manifestUses) return true;
		// Fail-closed fallback, for the window where the two layers could disagree.
		// The broker relaxes `transcripts:read`'s path match on the LEDGER carrying
		// a keyword scope, while the handler enforces `isSessionGranted` on the
		// MANIFEST requesting one. A manifest refresh that drops the keyword while
		// the old sandbox is still draining made the manifest side false and the
		// ledger side true, so neither check applied and the plugin could read
		// transcripts outside its grant set. Reading the ledger here keeps both
		// sides keyed on the same fact. Once members are granted the host rewrites
		// the scope to real ids, which is no longer a keyword scope - and by then
		// the broker stops relaxing too, so the pair still agrees.
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
		if (!this.usesSessionGrants(pluginId)) return false;
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
