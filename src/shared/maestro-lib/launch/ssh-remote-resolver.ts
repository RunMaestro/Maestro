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

import type { SshRemoteConfig, AgentSshRemoteConfig } from '../../types';

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

/**
 * Where an agent launch runs. `unresolved` means the user turned SSH on but no
 * usable remote was found, and the launch must FAIL rather than run locally:
 * the user opted into a remote host, and running on their own machine (against
 * the remote's cwd, no less) is a wrong answer that looks like a working one.
 * `getSshRemoteConfig` folds that case into `none`, which is how callers kept
 * falling back to local.
 */
export type SshLaunchTarget =
	| { kind: 'local' }
	| { kind: 'remote'; remote: SshRemoteConfig }
	| {
			kind: 'unresolved';
			reason: 'no-remote-selected' | 'remote-not-found' | 'remote-disabled' | 'no-remote-store';
			/** Says what is wrong and what to change, for showing to the user as-is. */
			message: string;
	  };

/**
 * Resolve where a launch runs, before anything is spawned. SSH is session-level
 * only (see `getSshRemoteConfig`); this adds the one thing that function cannot
 * say: that SSH was requested and cannot be honored, and why.
 */
export function resolveSshLaunchTarget(
	store: SshRemoteSettingsStore | undefined,
	sessionSshConfig: AgentSshRemoteConfig | null | undefined
): SshLaunchTarget {
	if (!sessionSshConfig?.enabled) return { kind: 'local' };

	const unresolved = (
		reason: Extract<SshLaunchTarget, { kind: 'unresolved' }>['reason'],
		detail: string
	): SshLaunchTarget => ({
		kind: 'unresolved',
		reason,
		message: `SSH remote execution is enabled for this agent, but ${detail} The agent was not started, so nothing ran on this machine instead.`,
	});

	const remoteId = sessionSshConfig.remoteId;
	if (!remoteId) {
		return unresolved(
			'no-remote-selected',
			'no remote is selected. Pick an SSH remote in the agent settings, or turn SSH off.'
		);
	}
	if (!store) {
		return unresolved(
			'no-remote-store',
			`the SSH remote list is not available here, so remote "${remoteId}" cannot be looked up.`
		);
	}
	const remote = store.getSshRemotes().find((r) => r.id === remoteId);
	if (!remote) {
		return unresolved(
			'remote-not-found',
			`its remote "${remoteId}" no longer exists. Choose another remote in the agent settings, or turn SSH off.`
		);
	}
	if (!remote.enabled) {
		const label = remote.name ? `"${remote.name}"` : `"${remoteId}"`;
		return unresolved(
			'remote-disabled',
			`its remote ${label} is disabled. Enable it in Settings -> SSH Hosts, or turn SSH off for this agent.`
		);
	}
	return { kind: 'remote', remote };
}
