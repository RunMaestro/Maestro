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
	isPathScoped,
	type PluginCapability,
	type PermissionGrant,
} from '../../shared/plugins/permissions';
import { expandPluginHomePath } from './plugin-home-path';
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

export interface PermissionBrokerDeps {
	/** Returns the live grants for a plugin (re-read each call so a revoked grant
	 * takes effect immediately, mirroring the Encore-flag re-read pattern). */
	getGrants: (pluginId: string) => PermissionGrant[];
	/** Optional audit sink for RPC decisions (allow and deny); host-only polling can opt out. */
	onDecision?: (pluginId: string, method: HostMethod, decision: BrokerDecision) => void;
	/** Absolute directory prefixes that fs:read AND fs:write must NEVER touch -
	 * the userData/config tree (grants, enable-state, encoreFeatures settings,
	 * agent-configs, cli-server.json, the plugins dir, plugin KV, supervisor
	 * targets, transcripts). Re-read each call. The integrator passes the real,
	 * resolved userData path(s). Enforced AFTER the grant check, so a broad fs
	 * grant can never reach into the data dir; because the fs handlers re-call
	 * authorize() with the symlink-resolved REAL path, the exclusion also holds
	 * post-resolution (a symlink inside a granted scope cannot escape into it). */
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

/**
 * Expand a leading `~` on both sides of a path comparison, so a grant scoped to
 * `~/.maestro/kanban-boards` covers a call targeting `~/.maestro/kanban-boards/x.yaml`
 * AND covers the already-expanded real path the fs handlers re-authorize with.
 * Only path-scoped capabilities expand (see `isPathScoped`): a host scope or an
 * exact allowlist member keeps its literal identity. Expansion is a no-op on
 * every string that does not start with `~`, so an absolute scope is untouched.
 */
function expandPathGrants(
	grants: readonly PermissionGrant[],
	capability: PluginCapability
): readonly PermissionGrant[] {
	if (!isPathScoped(capability)) return grants;
	let changed = false;
	const expanded = grants.map((g) => {
		if (g.capability !== capability || !g.scope) return g;
		const scope = expandPluginHomePath(g.scope);
		if (scope === g.scope) return g;
		changed = true;
		return { ...g, scope };
	});
	return changed ? expanded : grants;
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

export class PermissionBroker {
	constructor(private readonly deps: PermissionBrokerDeps) {}

	/**
	 * Authorize one host call. Default deny: returns allowed only when a matching
	 * grant covers the capability and (for scoped capabilities) the target.
	 * Host-owned liveness checks may suppress the RPC audit without changing authorization.
	 */
	authorize(
		pluginId: string,
		method: HostMethod,
		params: unknown,
		options?: { audit?: boolean }
	): BrokerDecision {
		const capability = HOST_METHOD_CAPABILITY[method];
		const rawTarget = extractTarget(method, params);
		// Expand `~` on both sides BEFORE anything compares them, and report the
		// expanded target in the decision: it is the path the host would actually
		// touch, so it is what the audit log and the deny reason should name.
		const target =
			rawTarget !== undefined && isPathScoped(capability)
				? expandPluginHomePath(rawTarget)
				: rawTarget;
		const grants = expandPathGrants(this.deps.getGrants(pluginId), capability);
		let allowed: boolean;
		let reason: string | undefined;
		if (method === 'media.close' || method === 'services.cancel' || method === 'services.status') {
			// Release ownership and status of an own declared requirement are checked
			// in the handlers. Revocation must not block cancellation or denied status.
			allowed = true;
		} else if (HANDLER_REAUTHORIZED_METHODS.has(method)) {
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
		if (options?.audit !== false) this.deps.onDecision?.(pluginId, method, decision);
		return decision;
	}
}
