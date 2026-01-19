/**
 * SSH Remote Configuration Resolver.
 *
 * Provides utilities for resolving which SSH remote configuration should
 * be used for agent execution.
 *
 * SSH is SESSION-LEVEL ONLY:
 * - Each session can have its own SSH config (sessionSshRemoteConfig)
 * - If no session SSH config, execution is local
 * - There is NO agent-level or global default SSH
 *
 * This module is used by the process spawn handlers to determine whether
 * an agent command should be executed locally or via SSH on a remote host.
 */

import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../shared/types';

/**
 * Options for resolving SSH remote configuration.
 */
export interface SshRemoteResolveOptions {
	/**
	 * Session-specific SSH remote configuration (optional).
	 * If provided and enabled, the session will execute via SSH.
	 * This is the ONLY way to enable SSH - there are no agent-level or global defaults.
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
	const { sessionSshConfig } = options;

	// Get all available SSH remotes
	const sshRemotes = store.getSshRemotes();

	// Check session-specific configuration (the ONLY way to enable SSH)
	if (sessionSshConfig) {
		// If explicitly disabled for this session, return null (local execution)
		if (!sessionSshConfig.enabled) {
			return {
				config: null,
				source: 'disabled',
			};
		}

		// If session has a specific remote ID configured, use it
		if (sessionSshConfig.remoteId) {
			const config = sshRemotes.find((r) => r.id === sessionSshConfig.remoteId && r.enabled);

			if (config) {
				return {
					config,
					source: 'session',
				};
			}
			// If the specified remote doesn't exist or is disabled, fall through to local execution
		}
	}

	// No SSH remote configured - local execution
	return {
		config: null,
		source: 'none',
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
