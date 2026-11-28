/**
 * Permission broker (main process).
 *
 * The single authorization gate between a sandboxed plugin's RPC calls and the
 * host. For every HostRequest it resolves the required capability and the call's
 * target, then checks the plugin's granted permissions with the pure
 * default-deny matcher. It does NOT execute the call - the sandbox host does
 * that only after `authorize` returns allowed. Keeping authorization separate
 * from execution means this gate can be unit-tested exhaustively without any
 * Electron. The one part that reads the file system is the protected-folder
 * check, which resolves real paths (read-only `realpath`) on both sides.
 */

import * as path from 'path';
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
import {
	foldPathCase,
	isPathWithin,
	realpathThroughAncestor,
} from '../utils/real-path-containment';

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
	 * targets, transcripts). Re-read each call. Enforced AFTER the grant check,
	 * so a broad fs grant can never reach into the data dir. The target and each
	 * prefix are both resolved to a canonical path before they are compared (`..`
	 * collapsed, symlinks followed, case folded on macOS and Windows), so a
	 * symlink, a `..` hop, or an upper-case spelling of the folder cannot slip by;
	 * the fs handlers also re-call authorize() with the symlink-resolved REAL path,
	 * so the exclusion holds post-resolution too. */
	protectedPaths?: () => readonly string[];
	/** The platform whose file-system case rules apply to `protectedPaths`
	 * (macOS and Windows are case-insensitive). Defaults to `process.platform`;
	 * a seam so a test can run another platform's rules on any host. */
	platform?: NodeJS.Platform;
}

/**
 * The form of a path used to compare it with a protected prefix: absolute, `..`
 * collapsed, symlinks resolved through the nearest existing ancestor (so a path
 * that does not exist yet lands where it would), and case-folded where the file
 * system is case-insensitive. The target and the prefix both go through it, so a
 * symlink, a `..` hop, and a case variant all name the same place as the prefix.
 */
function canonicalForCompare(p: string, platform: NodeJS.Platform): string {
	return foldPathCase(realpathThroughAncestor(path.resolve(p)), platform);
}

/** Is `target` equal to or inside any protected prefix? Separator-boundary
 * match so `/data/userdata-plugins` does not match prefix `/data/userdata`. */
function isUnderProtectedPath(
	target: string,
	prefixes: readonly string[],
	platform: NodeJS.Platform
): boolean {
	if (prefixes.length === 0) return false;
	const t = canonicalForCompare(target, platform);
	return prefixes.some((prefix) => isPathWithin(t, canonicalForCompare(prefix, platform)));
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
		const target = extractTarget(method, params);
		const grants = this.deps.getGrants(pluginId);
		let allowed: boolean;
		let reason: string | undefined;
		if (
			method === 'net.tlsClose' ||
			method === 'media.close' ||
			method === 'services.cancel' ||
			method === 'services.status'
		) {
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
			if (isUnderProtectedPath(target, protectedPaths, this.deps.platform ?? process.platform)) {
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
