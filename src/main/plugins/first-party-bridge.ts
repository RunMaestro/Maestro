/**
 * Host-owned lifecycle bridge for first-party plugin definitions (main process).
 *
 * One instance per `FirstPartyPluginDefinition` (generalized from the Pianola
 * bridge). The bridge does not execute plugin Host API calls itself and does
 * not loosen broker boundaries. It binds a feature's Encore flag, its grant
 * state in the sealed authorization ledger, and its supervised background
 * service lifecycle so that:
 *
 *  - enable  = grant mint + flag flip + service reconcile. First-party code is
 *    trusted by construction, so enabling MINTS the definition's declared
 *    grants host-side through the SAME authorization-ledger path community
 *    consents use (no consent window; the marketplace tile shows the
 *    permission list as disclosure).
 *  - disable = flag off + supervised work stops (grants stay; re-enable is
 *    cheap and does not re-mint when the grants still satisfy).
 *  - revoke  = grants gone + flag off + supervised work stops (fails closed).
 *
 * Grants-gone-behind-our-back (ledger reset, session-only relaunch) forces the
 * feature off on the next reconcile - never silently degraded operation.
 */

import type { FirstPartyPluginDefinition } from '../../shared/plugins/first-party';
import type { FirstPartyEncoreFlag } from '../../shared/plugins/first-party';
import {
	grantsFromRequests,
	isPermitted,
	type PermissionGrant,
} from '../../shared/plugins/permissions';
import type { AuthIdentity } from './authorization-ledger';

interface SettingsStoreLike {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
}

/** Lifecycle hooks for a feature's supervised background services. Features
 * without background services pass no-ops (the default). */
export interface FirstPartySupervisorHooks {
	/** (Re)start/settle supervised work for the current flag+grant state. */
	reconcile: () => void;
	/** Stop all supervised work now (disable/revoke/fail-closed). */
	stopAll: () => void;
}

export interface FirstPartyPluginBridgeDeps {
	settingsStore: SettingsStoreLike;
	/** Live grants for a plugin id - the sealed ledger's `readGrants`. */
	readGrants: (pluginId: string) => readonly PermissionGrant[];
	/**
	 * Mint the definition's declared grants host-side (first-party = trusted by
	 * construction). MUST write through the same authorization-ledger path real
	 * consents use and throw loudly when the ledger rejects the write.
	 */
	mintFirstPartyGrants: (definition: FirstPartyPluginDefinition) => void;
	/** Drop the plugin's grants - the sealed ledger's `revoke`. */
	revokeGrants: (pluginId: string) => void;
	/** Supervised background-service hooks; omit for service-less features. */
	supervisor?: FirstPartySupervisorHooks;
}

export interface FirstPartyBridgeState {
	enabled: boolean;
	authorized: boolean;
}

function readEncoreFeatures(settingsStore: SettingsStoreLike): Record<string, unknown> {
	const raw = settingsStore.get('encoreFeatures');
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}
	return { ...raw };
}

/** Do `grants` satisfy every permission the definition declares? */
export function hasRequiredFirstPartyGrants(
	definition: FirstPartyPluginDefinition,
	grants: readonly PermissionGrant[]
): boolean {
	return definition.permissions.every((request) =>
		isPermitted(grants, request.capability, request.scope)
	);
}

/**
 * The synthetic ledger identity for a first-party plugin. There is no plugin
 * directory to digest, so the content-hash slot carries an explicit
 * `first-party:` provenance marker (auditable in the sealed ledger), the
 * signature status is `trusted` (host code, trusted by construction), and
 * there is - honestly - no signer key.
 */
export function firstPartyAuthIdentity(definition: FirstPartyPluginDefinition): AuthIdentity {
	return {
		contentHash: `first-party:${definition.id}`,
		signatureStatus: 'trusted',
		signerKey: null,
	};
}

/**
 * Build the host-side grant minter over the sealed authorization ledger - the
 * SAME `mint` seam the consent window's minter writes through, so first-party
 * grants live in the sealed, anti-rollback ledger like every community grant.
 *
 * Fails loudly: after minting, the ledger is read back and the result must
 * satisfy the declared permission set; anything less throws (a first-party
 * feature must never run on silently-partial authority).
 */
export function createFirstPartyGrantMinter(
	store: {
		mint: (pluginId: string, caps: PermissionGrant[], identity: AuthIdentity) => void;
		readGrants: (pluginId: string) => readonly PermissionGrant[];
	},
	now: () => number = () => Date.now()
): (definition: FirstPartyPluginDefinition) => void {
	return (definition) => {
		const grants = grantsFromRequests([...definition.permissions], now());
		store.mint(definition.id, grants, firstPartyAuthIdentity(definition));
		const minted = store.readGrants(definition.id);
		if (!hasRequiredFirstPartyGrants(definition, minted)) {
			throw new Error(
				`Authorization ledger rejected first-party grants for "${definition.id}": ` +
					`minted ${minted.length}/${definition.permissions.length} declared capabilities`
			);
		}
	};
}

/**
 * Host-owned lifecycle bridge: one per first-party plugin definition.
 */
export class FirstPartyPluginBridge {
	constructor(
		readonly definition: FirstPartyPluginDefinition,
		private readonly deps: FirstPartyPluginBridgeDeps
	) {}

	private authorized(): boolean {
		return hasRequiredFirstPartyGrants(this.definition, this.deps.readGrants(this.definition.id));
	}

	private setFlag(enabled: boolean): void {
		const encoreFeatures = readEncoreFeatures(this.deps.settingsStore);
		this.deps.settingsStore.set('encoreFeatures', {
			...encoreFeatures,
			[this.definition.encoreFlag]: enabled,
		});
	}

	state(): FirstPartyBridgeState {
		const authorized = this.authorized();
		return {
			enabled:
				readEncoreFeatures(this.deps.settingsStore)[this.definition.encoreFlag] === true &&
				authorized,
			authorized,
		};
	}

	/**
	 * Enable: mint the declared grants host-side (idempotent - skipped when the
	 * live grants already satisfy the declaration), flip the flag, reconcile
	 * supervised work. Disable: flag off + supervised work stops (grants kept).
	 * A minter failure propagates AFTER the state has been forced off - the
	 * feature never runs without its declared authority.
	 */
	setEnabled(enabled: boolean): FirstPartyBridgeState {
		if (!enabled) {
			this.setFlag(false);
			this.deps.supervisor?.stopAll();
			return { enabled: false, authorized: this.authorized() };
		}
		if (!this.authorized()) {
			try {
				this.deps.mintFirstPartyGrants(this.definition);
			} catch (err) {
				this.setFlag(false);
				this.deps.supervisor?.stopAll();
				throw err;
			}
			if (!this.authorized()) {
				// A minter that silently under-delivers (contract violation) still
				// fails closed rather than enabling on partial authority.
				this.setFlag(false);
				this.deps.supervisor?.stopAll();
				return { enabled: false, authorized: false };
			}
		}
		this.setFlag(true);
		this.deps.supervisor?.reconcile();
		return { enabled: true, authorized: true };
	}

	/** Revoke: grants gone + flag off + supervised work stops. Fails closed. */
	revoke(): FirstPartyBridgeState {
		this.deps.revokeGrants(this.definition.id);
		this.setFlag(false);
		this.deps.supervisor?.stopAll();
		return { enabled: false, authorized: false };
	}

	/**
	 * Settle supervised work against the CURRENT flag+grant state: grants gone
	 * or flag off → stop everything and force the flag off; otherwise reconcile.
	 */
	reconcileBackgroundService(): FirstPartyBridgeState {
		const authorized = this.authorized();
		if (
			readEncoreFeatures(this.deps.settingsStore)[this.definition.encoreFlag] !== true ||
			!authorized
		) {
			this.setFlag(false);
			this.deps.supervisor?.stopAll();
			return { enabled: false, authorized };
		}
		this.deps.supervisor?.reconcile();
		return { enabled: true, authorized: true };
	}
}

/**
 * Active bridge registry (mirrors `plugin-manager-singleton.ts`): the bridges
 * are constructed during core-service init in `index.ts` and held here so the
 * IPC togglers (and feature workers' handlers) can look them up by Encore flag
 * without threading them through every handler constructor.
 */
let activeBridges: Partial<Record<FirstPartyEncoreFlag, FirstPartyPluginBridge>> = {};

export function setFirstPartyBridges(
	bridges: Partial<Record<FirstPartyEncoreFlag, FirstPartyPluginBridge>>
): void {
	activeBridges = bridges;
}

export function getFirstPartyBridge(flag: FirstPartyEncoreFlag): FirstPartyPluginBridge | null {
	return activeBridges[flag] ?? null;
}
