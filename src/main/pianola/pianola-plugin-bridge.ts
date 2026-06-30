import {
	PIANOLA_FIRST_PARTY_PLUGIN_ID,
	PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS,
} from '../../shared/pianola/first-party-plugin';
import { isPermitted, type PermissionGrant } from '../../shared/plugins/permissions';

interface SettingsStoreLike {
	get: (key: string) => unknown;
	set: (key: string, value: unknown) => void;
}

interface PianolaSupervisorBridge {
	reconcile: () => void;
	stopAll: () => void;
}

export interface PianolaFirstPartyPluginBridgeDeps {
	settingsStore: SettingsStoreLike;
	readGrants: (pluginId: string) => readonly PermissionGrant[];
	revokeGrants: (pluginId: string) => void;
	supervisor: PianolaSupervisorBridge;
}

export interface PianolaBridgeState {
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

function setPianolaFlag(settingsStore: SettingsStoreLike, enabled: boolean): void {
	const encoreFeatures = readEncoreFeatures(settingsStore);
	settingsStore.set('encoreFeatures', { ...encoreFeatures, pianola: enabled });
}

export function pianolaHasRequiredPluginGrants(grants: readonly PermissionGrant[]): boolean {
	return PIANOLA_FIRST_PARTY_PLUGIN_PERMISSIONS.every((request) =>
		isPermitted(grants, request.capability, request.scope)
	);
}

/**
 * Host-owned lifecycle bridge for Pianola's first-party plugin metadata.
 *
 * The bridge does not execute plugin Host API calls itself and does not loosen
 * broker boundaries. It only binds Pianola's existing Encore flag, grant state,
 * and supervised background service lifecycle so disabling or revoking consent
 * fails closed by stopping all Pianola work.
 */
export class PianolaFirstPartyPluginBridge {
	constructor(private readonly deps: PianolaFirstPartyPluginBridgeDeps) {}

	state(): PianolaBridgeState {
		const authorized = pianolaHasRequiredPluginGrants(
			this.deps.readGrants(PIANOLA_FIRST_PARTY_PLUGIN_ID)
		);
		return {
			enabled: readEncoreFeatures(this.deps.settingsStore).pianola === true && authorized,
			authorized,
		};
	}

	setEnabled(enabled: boolean): PianolaBridgeState {
		const authorized = pianolaHasRequiredPluginGrants(
			this.deps.readGrants(PIANOLA_FIRST_PARTY_PLUGIN_ID)
		);
		if (!enabled) {
			setPianolaFlag(this.deps.settingsStore, false);
			this.deps.supervisor.stopAll();
			return { enabled: false, authorized };
		}
		if (!authorized) {
			setPianolaFlag(this.deps.settingsStore, false);
			return { enabled: false, authorized: false };
		}
		setPianolaFlag(this.deps.settingsStore, true);
		this.deps.supervisor.reconcile();
		return { enabled: true, authorized: true };
	}

	revoke(): PianolaBridgeState {
		this.deps.revokeGrants(PIANOLA_FIRST_PARTY_PLUGIN_ID);
		setPianolaFlag(this.deps.settingsStore, false);
		this.deps.supervisor.stopAll();
		return { enabled: false, authorized: false };
	}

	reconcileBackgroundService(): PianolaBridgeState {
		const authorized = pianolaHasRequiredPluginGrants(
			this.deps.readGrants(PIANOLA_FIRST_PARTY_PLUGIN_ID)
		);
		if (readEncoreFeatures(this.deps.settingsStore).pianola !== true || !authorized) {
			setPianolaFlag(this.deps.settingsStore, false);
			this.deps.supervisor.stopAll();
			return { enabled: false, authorized };
		}
		this.deps.supervisor.reconcile();
		return { enabled: true, authorized: true };
	}
}
