/**
 * SSH Remote Configuration Resolver.
 *
 * Provides utilities for resolving which SSH remote configuration should
 * be used for agent execution.
 *
 * The legacy `resolveSshRemoteConfig` API remains session-only: an enabled
 * session config selects SSH and otherwise execution is local. The newer
 * pure ID-policy API separately models explicit, session, default, and local
 * precedence before typed lookup. Callers choose the policy appropriate to
 * their execution surface.
 */

import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../shared/types';

/**
 * Options for resolving SSH remote configuration.
 */
export interface SshRemoteResolveOptions {
	/**
	 * Session-specific SSH remote configuration (optional).
	 * If provided and enabled, the session will execute via SSH.
	 * This compatibility API does not consult agent-level or global defaults.
	 */
	sessionSshConfig?: AgentSshRemoteConfig;
}

/**
 * Result of SSH remote configuration resolution.
 */
export interface SshRemoteResolveResult {
	/**
	 * The resolved SSH remote configuration, or null for local execution.
	 */
	config: SshRemoteConfig | null;

	/**
	 * How the configuration was resolved.
	 * - 'session': Session-level SSH config was used
	 * - 'disabled': SSH remote is explicitly disabled for this session
	 * - 'none': No SSH remote configured (local execution)
	 */
	source: 'session' | 'disabled' | 'none';
}

/**
 * Store interface for accessing SSH remote settings.
 * This allows dependency injection for testing.
 */
export interface SshRemoteSettingsStore {
	/**
	 * Get all SSH remote configurations.
	 */
	getSshRemotes(): SshRemoteConfig[];
}

export type SshRemoteLookupResult =
	| { status: 'enabled'; config: SshRemoteConfig }
	| { status: 'disabled'; config: SshRemoteConfig }
	| { status: 'not-found'; config: null };

export type SshRemoteIdSource = 'explicit' | 'session' | 'default' | 'local';

export interface SshRemoteIdResolveOptions {
	explicitRemoteId?: string | null;
	sessionSshConfig?: AgentSshRemoteConfig | null;
	defaultRemoteId?: string | null;
}

export interface SshRemoteIdResolution {
	remoteId: string | undefined;
	source: SshRemoteIdSource;
}

export type SshSpawnResolution =
	| {
			mode: 'remote';
			remote: SshRemoteConfig;
			source: Exclude<SshRemoteIdSource, 'local'>;
			status: 'enabled';
	  }
	| {
			mode: 'local';
			remote: null;
			source: SshRemoteIdSource;
			status: 'disabled' | 'not-found' | 'local';
	  };

function nonEmptyRemoteId(remoteId: string | null | undefined): string | undefined {
	const trimmed = remoteId?.trim();
	return trimmed || undefined;
}

/** Reports stored enabled state without imposing an execution fallback policy. */
export function lookupSshRemoteById(
	store: SshRemoteSettingsStore,
	remoteId: string
): SshRemoteLookupResult {
	const config = store.getSshRemotes().find((remote) => remote.id === remoteId);
	if (!config) {
		return { status: 'not-found', config: null };
	}
	return config.enabled ? { status: 'enabled', config } : { status: 'disabled', config };
}

/**
 * Resolves remote-ID precedence only; lookup and command construction remain
 * distinct contracts.
 */
export function resolveSshRemoteId(options: SshRemoteIdResolveOptions = {}): SshRemoteIdResolution {
	const explicitRemoteId = nonEmptyRemoteId(options.explicitRemoteId);
	if (explicitRemoteId) {
		return { remoteId: explicitRemoteId, source: 'explicit' };
	}

	if (options.sessionSshConfig) {
		if (!options.sessionSshConfig.enabled) {
			return { remoteId: undefined, source: 'local' };
		}
		const sessionRemoteId = nonEmptyRemoteId(options.sessionSshConfig.remoteId);
		return sessionRemoteId
			? { remoteId: sessionRemoteId, source: 'session' }
			: { remoteId: undefined, source: 'local' };
	}

	const defaultRemoteId = nonEmptyRemoteId(options.defaultRemoteId);
	return defaultRemoteId
		? { remoteId: defaultRemoteId, source: 'default' }
		: { remoteId: undefined, source: 'local' };
}

/**
 * Resolves a spawn target with provenance. Authentication is a transport
 * concern: an enabled remote remains remote so SSH can surface that error.
 */
export function resolveSshSpawn(
	store: SshRemoteSettingsStore,
	options: SshRemoteIdResolveOptions = {}
): SshSpawnResolution {
	if (options.sessionSshConfig && !options.sessionSshConfig.enabled) {
		return { mode: 'local', remote: null, source: 'local', status: 'disabled' };
	}

	const idResolution = resolveSshRemoteId(options);
	if (!idResolution.remoteId) {
		const malformedEnabledSession =
			!!options.sessionSshConfig?.enabled && !nonEmptyRemoteId(options.sessionSshConfig.remoteId);
		return {
			mode: 'local',
			remote: null,
			source: idResolution.source,
			status: malformedEnabledSession ? 'not-found' : 'local',
		};
	}

	if (idResolution.source === 'local') {
		return { mode: 'local', remote: null, source: 'local', status: 'local' };
	}

	const lookup = lookupSshRemoteById(store, idResolution.remoteId);
	if (lookup.status === 'enabled') {
		return {
			mode: 'remote',
			remote: lookup.config,
			source: idResolution.source,
			status: 'enabled',
		};
	}

	return {
		mode: 'local',
		remote: null,
		source: idResolution.source,
		status: lookup.status,
	};
}

/**
 * Resolve the effective SSH remote configuration for agent execution.
 *
 * SSH is session-level only:
 * 1. If sessionSshConfig is provided and explicitly disabled -> local execution
 * 2. If sessionSshConfig is provided with a remoteId -> use that specific remote
 * 3. Otherwise -> local execution (no defaults)
 *
 * @param store The settings store to read SSH remote configurations from
 * @param options Resolution options including session-specific config
 * @returns Resolved SSH remote configuration with source information
 *
 * @example
 * // No session config = local execution
 * const result = getSshRemoteConfig(store, {});
 * // result.config === null, result.source === 'none'
 *
 * @example
 * // With session-specific SSH config
 * const result = getSshRemoteConfig(store, {
 *   sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
 * });
 */
export function getSshRemoteConfig(
	store: SshRemoteSettingsStore,
	options: SshRemoteResolveOptions = {}
): SshRemoteResolveResult {
	const resolution = resolveSshSpawn(store, {
		sessionSshConfig: options.sessionSshConfig,
	});
	if (resolution.mode === 'remote') {
		return { config: resolution.remote, source: 'session' };
	}
	return {
		config: null,
		source: options.sessionSshConfig && !options.sessionSshConfig.enabled ? 'disabled' : 'none',
	};
}

/**
 * Create a SshRemoteSettingsStore adapter from an electron-store instance.
 *
 * This adapter wraps an electron-store to provide the SshRemoteSettingsStore
 * interface, allowing the resolver to be used with the actual settings store.
 *
 * @param store The electron-store instance with SSH remote settings
 * @returns A SshRemoteSettingsStore adapter
 *
 * @example
 * const storeAdapter = createSshRemoteStoreAdapter(settingsStore);
 * const result = getSshRemoteConfig(storeAdapter, {
 *   sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
 * });
 */
export function createSshRemoteStoreAdapter<
	T extends {
		get(key: 'sshRemotes', defaultValue: SshRemoteConfig[]): SshRemoteConfig[];
	},
>(store: T): SshRemoteSettingsStore {
	return {
		getSshRemotes: () => store.get('sshRemotes', []),
	};
}
