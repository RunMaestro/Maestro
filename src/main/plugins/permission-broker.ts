/**
 * Permission broker (main process).
 *
 * The single authorization gate between a sandboxed plugin's RPC calls and the
 * host. For every HostRequest it resolves the required capability and the call's
 * target, then checks the plugin's granted permissions with the pure
 * default-deny matcher. It does NOT execute the call - the sandbox host does
 * that only after `authorize` returns allowed. Keeping authorization separate
 * from execution means this gate can be unit-tested exhaustively without any
 * Electron or fs.
 */

import {
	isPermitted,
	type PluginCapability,
	type PermissionGrant,
} from '../../shared/plugins/permissions';
import {
	HOST_METHOD_CAPABILITY,
	HANDLER_REAUTHORIZED_METHODS,
	extractTarget,
	type HostMethod,
} from '../../shared/plugins/rpc-protocol';

export interface BrokerDecision {
	allowed: boolean;
	capability: PluginCapability;
	/** The resolved scope target (path/host), when the capability is scoped. */
	target?: string;
	/** Why the call was denied (empty when allowed). */
	reason?: string;
}

/**
 * Host-only provenance for a running plugin activation. It is captured from the
 * verified snapshot when the host starts a sandbox; guest RPC payloads never
 * supply or override these fields.
 */
export interface PluginAuthorizationIdentity {
	ownerPluginId: string;
	generation: number;
	artifactDigest: string;
	signerKeyId: string;
}

export interface GrantedPluginIdentity {
	contentHash: string;
	signerKey: string | null;
}

export interface PermissionBrokerDeps {
	/** Returns the live grants for a plugin (re-read each call so a revoked grant
	 * takes effect immediately, mirroring the Encore-flag re-read pattern). */
	getGrants: (pluginId: string) => PermissionGrant[];
	/** Current host-owned activation provenance. Production MUST supply this for
	 * sandbox calls; no guest-controlled value can satisfy this check. */
	getActivationIdentity?: (pluginId: string) => PluginAuthorizationIdentity | null;
	/** Identity sealed into the authorization ledger at consent time. */
	getGrantedIdentity?: (pluginId: string) => GrantedPluginIdentity | null;
	/** Optional audit sink for every decision (allow and deny). */
	onDecision?: (pluginId: string, method: HostMethod, decision: BrokerDecision) => void;
	/** Absolute directory prefixes that fs:read AND fs:write must NEVER touch -
	 * the userData/config tree (grants, enable-state, encoreFeatures settings,
	 * agent-configs, cli-server.json, the plugins dir, plugin KV, supervisor
	 * targets, transcripts). Re-read each call. Enforced AFTER the grant check, so a
	 * broad fs grant can never reach into the data dir; because the fs handlers
	 * re-call authorize() with the symlink-resolved REAL path, the exclusion also
	 * holds post-resolution (a symlink inside a granted scope cannot escape into
	 * it). */
	protectedPaths?: () => readonly string[];
}

/**
 * Normalize a path for protected-prefix comparison: forward slashes, no trailing
 * separator, and case-folded on Windows (its filesystem is case-insensitive).
 */
function normalizeForPrefix(p: string): string {
	let out = p.replace(/\\/g, '/').replace(/\/+$/, '');
	if (out === '') out = '/';
	return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** Is `target` equal to or inside any protected prefix? Separator-boundary
 * match so `/data/userdata-plugins` does not match prefix `/data/userdata`. */
function isUnderProtectedPath(target: string, prefixes: readonly string[]): boolean {
	const t = normalizeForPrefix(target);
	for (const prefix of prefixes) {
		const p = normalizeForPrefix(prefix);
		if (t === p || t.startsWith(p === '/' ? '/' : `${p}/`)) return true;
	}
	return false;
}

function sameAuthorizationIdentity(
	left: PluginAuthorizationIdentity,
	right: PluginAuthorizationIdentity
): boolean {
	return (
		left.ownerPluginId === right.ownerPluginId &&
		left.generation === right.generation &&
		left.artifactDigest === right.artifactDigest &&
		left.signerKeyId === right.signerKeyId
	);
}

export class PermissionBroker {
	constructor(private readonly deps: PermissionBrokerDeps) {}

	/**
	 * Authorize a sandbox-originated call with host-injected snapshot provenance.
	 * This is intentionally distinct from `authorize`: callers must close over a
	 * RunningPlugin identity, not accept any provenance object from guest data.
	 */
	authorizeInvocation(
		identity: PluginAuthorizationIdentity,
		method: HostMethod,
		params: unknown
	): BrokerDecision {
		const capability = HOST_METHOD_CAPABILITY[method];
		const active = this.deps.getActivationIdentity?.(identity.ownerPluginId);
		const granted = this.deps.getGrantedIdentity?.(identity.ownerPluginId);
		if (
			!active ||
			!sameAuthorizationIdentity(active, identity) ||
			!granted ||
			granted.contentHash !== identity.artifactDigest ||
			granted.signerKey !== identity.signerKeyId
		) {
			const decision: BrokerDecision = {
				allowed: false,
				capability,
				reason: 'authorization identity mismatch',
			};
			this.deps.onDecision?.(identity.ownerPluginId, method, decision);
			return decision;
		}
		return this.authorize(identity.ownerPluginId, method, params);
	}

	/**
	 * Authorize one host call. Default deny: returns allowed only when a matching
	 * grant covers the capability and (for scoped capabilities) the target.
	 */
	authorize(pluginId: string, method: HostMethod, params: unknown): BrokerDecision {
		const capability = HOST_METHOD_CAPABILITY[method];
		const target = extractTarget(method, params);
		const grants = this.deps.getGrants(pluginId);
		let allowed: boolean;
		let reason: string | undefined;
		if (HANDLER_REAUTHORIZED_METHODS.has(method)) {
			// Scope lives in an already-open resource the params reference by opaque
			// id, not here. Confirm only that the capability is held; the host handler
			// re-authorizes the resource's real origin against the live grant. Without
			// this, a scoped grant (the recommended form) would be denied for a
			// missing target even though the operation is in-scope.
			allowed = grants.some((g) => g.capability === capability);
			reason = allowed ? undefined : `permission denied: ${capability}`;
		} else {
			allowed = isPermitted(grants, capability, target);
			reason = allowed
				? undefined
				: `permission denied: ${capability}${target ? ` (${target})` : ''}`;
		}

		// Structural data-dir exclusion: fs:read AND fs:write can never touch the
		// userData/config tree, regardless of how broad the grant is. Applied to
		// whatever path the caller passed - including the symlink-resolved REAL
		// path the fs handlers re-authorize with - so it holds post-resolution.
		if (allowed && (capability === 'fs:read' || capability === 'fs:write') && target) {
			const protectedPaths = this.deps.protectedPaths?.() ?? [];
			if (isUnderProtectedPath(target, protectedPaths)) {
				allowed = false;
				reason = `permission denied: ${capability} into a protected location (${target})`;
			}
		}

		const decision: BrokerDecision = {
			allowed,
			capability,
			...(target !== undefined ? { target } : {}),
			...(reason !== undefined ? { reason } : {}),
		};
		this.deps.onDecision?.(pluginId, method, decision);
		return decision;
	}
}
