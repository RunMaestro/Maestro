/**
 * Pure plugin registry.
 *
 * Holds the set of discovered plugins and their derived load status plus the
 * user's enable/disable toggle. Everything here is pure and immutable so it can
 * be unit-tested without a filesystem and reused by main, renderer, and CLI. The
 * main process owns discovery (reading dirs) and persistence (the enable state);
 * this module owns the shape and the rules.
 */

import {
	validatePluginManifest,
	isManifestHostCompatible,
	type PluginManifest,
} from './plugin-manifest';
import { isHostApiCompatible } from './host-api';

/**
 * Why a plugin is or is not loadable, independent of the user's toggle:
 * - 'ok': manifest valid and host-compatible.
 * - 'invalid': manifest failed validation (malformed plugin.json).
 * - 'incompatible': manifest valid but targets a different host API.
 */
export type PluginLoadStatus = 'ok' | 'invalid' | 'incompatible';

/** One plugin as the registry sees it. */
export interface PluginRecord {
	/** Manifest id when valid, else the discovery folder name (so it is listable). */
	id: string;
	/** Parsed manifest, or null when the manifest is invalid. */
	manifest: PluginManifest | null;
	/** Absolute path to the plugin's directory on disk. */
	source: string;
	/** Derived loadability, independent of the user toggle. */
	loadStatus: PluginLoadStatus;
	/** User enable toggle (persisted). A plugin only runs when enabled AND ok. */
	enabled: boolean;
	/** Validation errors or the incompatibility reason (empty when ok). */
	errors: string[];
	/**
	 * Signature trust status, attached by the main-process manager after disk
	 * verification (the pure builder cannot read files). Absent until verified.
	 */
	signature?: PluginSignatureInfo;
}

/** Minimal signature info carried on a record (decoupled from the verifier). */
export interface PluginSignatureInfo {
	status: 'unsigned' | 'invalid' | 'untrusted' | 'trusted';
	signerKey?: string;
	detail?: string;
}

/** The full registry value. */
export interface PluginRegistry {
	records: PluginRecord[];
}

/** A fresh, empty registry. */
export function emptyRegistry(): PluginRegistry {
	return { records: [] };
}

/**
 * Build a record from a raw (parsed-JSON) manifest discovered at `source`.
 * Validates the manifest, then host-compatibility, and folds both into a single
 * record. `enabled` is the persisted user toggle (defaults to true for a freshly
 * discovered, valid plugin unless the caller knows otherwise).
 */
export function buildRecord(args: {
	source: string;
	folderName: string;
	rawManifest: unknown;
	enabled: boolean;
	hostVersion?: string;
}): PluginRecord {
	const { source, folderName, rawManifest, enabled, hostVersion } = args;
	const { manifest, errors } = validatePluginManifest(rawManifest);

	if (!manifest) {
		return {
			id: folderName,
			manifest: null,
			source,
			loadStatus: 'invalid',
			enabled: false,
			errors,
		};
	}

	if (!isManifestHostCompatible(manifest, hostVersion)) {
		const reason = isHostApiCompatible(manifest.maestro.minHostApi, hostVersion).reason;
		return {
			id: manifest.id,
			manifest,
			source,
			loadStatus: 'incompatible',
			enabled: false,
			errors: [reason],
		};
	}

	return { id: manifest.id, manifest, source, loadStatus: 'ok', enabled, errors: [] };
}

/** Find a record by id, or undefined. */
export function getRecord(registry: PluginRegistry, id: string): PluginRecord | undefined {
	return registry.records.find((r) => r.id === id);
}

/**
 * Insert or replace a record by id. Immutable: returns a new registry. A later
 * record with the same id wins (last discovery overwrites), preserving array
 * order for an existing id.
 */
export function upsertRecord(registry: PluginRegistry, record: PluginRecord): PluginRegistry {
	const index = registry.records.findIndex((r) => r.id === record.id);
	const records =
		index >= 0
			? registry.records.map((r, i) => (i === index ? record : r))
			: [...registry.records, record];
	return { records };
}

/** Remove a record by id. Immutable. */
export function removeRecord(registry: PluginRegistry, id: string): PluginRegistry {
	return { records: registry.records.filter((r) => r.id !== id) };
}

/**
 * Set the enable toggle for a record. Immutable, no-op when the id is unknown.
 * Enabling a non-ok plugin is refused (the toggle stays false) because running
 * an invalid/incompatible plugin makes no sense; callers should surface why.
 */
export function setEnabled(registry: PluginRegistry, id: string, enabled: boolean): PluginRegistry {
	return {
		records: registry.records.map((r) => {
			if (r.id !== id) return r;
			if (enabled && r.loadStatus !== 'ok') return r;
			return { ...r, enabled };
		}),
	};
}

/** All records the host should actually activate: enabled AND loadable. */
export function listActive(registry: PluginRegistry): PluginRecord[] {
	return registry.records.filter((r) => r.enabled && r.loadStatus === 'ok');
}

/** The persisted enable-state map (id -> enabled), derived from the registry. */
export function toEnableState(registry: PluginRegistry): Record<string, boolean> {
	const state: Record<string, boolean> = {};
	for (const r of registry.records) {
		if (r.loadStatus === 'ok') state[r.id] = r.enabled;
	}
	return state;
}
