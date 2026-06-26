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
	/** Optional audit sink for every decision (allow and deny). */
	onDecision?: (pluginId: string, method: HostMethod, decision: BrokerDecision) => void;
}

export class PermissionBroker {
	constructor(private readonly deps: PermissionBrokerDeps) {}

	/**
	 * Authorize one host call. Default deny: returns allowed only when a matching
	 * grant covers the capability and (for scoped capabilities) the target.
	 */
	authorize(pluginId: string, method: HostMethod, params: unknown): BrokerDecision {
		const capability = HOST_METHOD_CAPABILITY[method];
		const target = extractTarget(method, params);
		const grants = this.deps.getGrants(pluginId);
		const allowed = isPermitted(grants, capability, target);
		const decision: BrokerDecision = {
			allowed,
			capability,
			...(target !== undefined ? { target } : {}),
			...(allowed
				? {}
				: { reason: `permission denied: ${capability}${target ? ` (${target})` : ''}` }),
		};
		this.deps.onDecision?.(pluginId, method, decision);
		return decision;
	}
}
