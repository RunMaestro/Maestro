import { useState, useEffect, useCallback } from 'react';
import type { SshRemoteConfig, SshRemoteTestResult } from '../../../shared/types';
import { ipcCache } from '../../services/ipcWrapper';

/**
 * Return type for the useSshRemotes hook
 */
export interface UseSshRemotesReturn {
	// State
	/** List of all SSH remote configurations */
	configs: SshRemoteConfig[];
	/** ID of the default SSH remote (null if none) */
	defaultId: string | null;
	/** Whether the hook is currently loading initial data */
	loading: boolean;
	/** Error message if any operation failed */
	error: string | null;

	// CRUD Operations
	/** Save (create or update) an SSH remote configuration */
	saveConfig: (config: Partial<SshRemoteConfig> & { id?: string }) => Promise<{
		success: boolean;
		config?: SshRemoteConfig;
		error?: string;
	}>;
	/** Delete an SSH remote configuration by ID */
	deleteConfig: (id: string) => Promise<{ success: boolean; error?: string }>;
	/** Refresh the list of configurations from the backend */
	refresh: () => Promise<void>;

	// Default Management
	/** Set the default SSH remote ID */
	setDefaultId: (id: string | null) => Promise<{ success: boolean; error?: string }>;

	// Connection Testing
	/** Test an SSH connection (by ID or with full config) */
	testConnection: (
		configOrId: string | SshRemoteConfig,
		agentCommand?: string
	) => Promise<{ success: boolean; result?: SshRemoteTestResult; error?: string }>;
	/** ID of the config currently being tested (null if not testing) */
	testingConfigId: string | null;
}

/**
 * Hook that manages SSH remote configurations for executing agents on remote hosts.
 *
 * Features:
 * - Loads and caches SSH remote configurations from backend
 * - Manages the global default SSH remote ID
 * - Provides CRUD operations (save/delete/refresh)
 * - Supports connection testing with loading state
 * - Handles errors gracefully with user-friendly messages
 *
 * Usage:
 * ```tsx
 * const {
 *   configs,
 *   defaultId,
 *   loading,
 *   saveConfig,
 *   deleteConfig,
 *   setDefaultId,
 *   testConnection,
 * } = useSshRemotes();
 * ```
 *
 * @returns Object containing SSH remote state and operations
 */
export function useSshRemotes(): UseSshRemotesReturn {
	// State
	const [configs, setConfigs] = useState<SshRemoteConfig[]>([]);
	const [defaultId, setDefaultIdState] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [testingConfigId, setTestingConfigId] = useState<string | null>(null);

	/**
	 * Load configurations from backend (with 30s cache to reduce IPC calls)
	 */
	const loadConfigs = useCallback(async () => {
		try {
			const result = await ipcCache.getOrFetch(
				'ssh-configs',
				() => window.maestro.sshRemote.getConfigs(),
				30000
			);
			if (result.success && result.configs) {
				setConfigs(result.configs);
			} else {
				setError(result.error || 'Failed to load SSH remote configurations');
			}
		} catch (err) {
			console.error('[useSshRemotes] Failed to load configs:', err);
			setError(err instanceof Error ? err.message : 'Failed to load SSH remote configurations');
		}
	}, []);

	/**
	 * Load default ID from backend
	 */
	const loadDefaultId = useCallback(async () => {
		try {
			const result = await window.maestro.sshRemote.getDefaultId();
			if (result.success) {
				setDefaultIdState(result.id ?? null);
			} else {
				console.error('[useSshRemotes] Failed to load default ID:', result.error);
			}
		} catch (err) {
			console.error('[useSshRemotes] Failed to load default ID:', err);
		}
	}, []);

	/**
	 * Refresh all data from backend (invalidates cache)
	 */
	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		// Invalidate cache to force fresh fetch
		ipcCache.invalidate('ssh-configs');
		await Promise.all([loadConfigs(), loadDefaultId()]);
		setLoading(false);
	}, [loadConfigs, loadDefaultId]);

	// Load initial data
	useEffect(() => {
		refresh();
	}, [refresh]);

	/**
	 * Save (create or update) an SSH remote configuration
	 */
	const saveConfig = useCallback(
		async (
			config: Partial<SshRemoteConfig> & { id?: string }
		): Promise<{ success: boolean; config?: SshRemoteConfig; error?: string }> => {
			try {
				const result = await window.maestro.sshRemote.saveConfig(config);
				if (result.success && result.config) {
					// Invalidate cache since configs changed
					ipcCache.invalidate('ssh-configs');
					// Update local state
					setConfigs((prev) => {
						const index = prev.findIndex((c) => c.id === result.config!.id);
						if (index >= 0) {
							// Update existing
							const updated = [...prev];
							updated[index] = result.config!;
							return updated;
						} else {
							// Add new
							return [...prev, result.config!];
						}
					});
					setError(null);
					return { success: true, config: result.config };
				} else {
					const errorMsg = result.error || 'Failed to save SSH remote configuration';
					setError(errorMsg);
					return { success: false, error: errorMsg };
				}
			} catch (err) {
				console.error('[useSshRemotes] Failed to save config:', err);
				const errorMsg =
					err instanceof Error ? err.message : 'Failed to save SSH remote configuration';
				setError(errorMsg);
				return { success: false, error: errorMsg };
			}
		},
		[]
	);

	/**
	 * Delete an SSH remote configuration by ID
	 */
	const deleteConfig = useCallback(
		async (id: string): Promise<{ success: boolean; error?: string }> => {
			try {
				const result = await window.maestro.sshRemote.deleteConfig(id);
				if (result.success) {
					// Invalidate cache since configs changed
					ipcCache.invalidate('ssh-configs');
					// Update local state
					setConfigs((prev) => prev.filter((c) => c.id !== id));
					// If deleted config was the default, update default state
					if (defaultId === id) {
						setDefaultIdState(null);
					}
					setError(null);
					return { success: true };
				} else {
					const errorMsg = result.error || 'Failed to delete SSH remote configuration';
					setError(errorMsg);
					return { success: false, error: errorMsg };
				}
			} catch (err) {
				console.error('[useSshRemotes] Failed to delete config:', err);
				const errorMsg =
					err instanceof Error ? err.message : 'Failed to delete SSH remote configuration';
				setError(errorMsg);
				return { success: false, error: errorMsg };
			}
		},
		[defaultId]
	);

	/**
	 * Set the default SSH remote ID
	 */
	const setDefaultId = useCallback(
		async (id: string | null): Promise<{ success: boolean; error?: string }> => {
			try {
				const result = await window.maestro.sshRemote.setDefaultId(id);
				if (result.success) {
					setDefaultIdState(id);
					setError(null);
					return { success: true };
				} else {
					const errorMsg = result.error || 'Failed to set default SSH remote';
					setError(errorMsg);
					return { success: false, error: errorMsg };
				}
			} catch (err) {
				console.error('[useSshRemotes] Failed to set default ID:', err);
				const errorMsg = err instanceof Error ? err.message : 'Failed to set default SSH remote';
				setError(errorMsg);
				return { success: false, error: errorMsg };
			}
		},
		[]
	);

	/**
	 * Test an SSH connection
	 */
	const testConnection = useCallback(
		async (
			configOrId: string | SshRemoteConfig,
			agentCommand?: string
		): Promise<{ success: boolean; result?: SshRemoteTestResult; error?: string }> => {
			// Determine the config ID for testing state
			const testId = typeof configOrId === 'string' ? configOrId : configOrId.id;
			setTestingConfigId(testId);

			try {
				const result = await window.maestro.sshRemote.test(configOrId, agentCommand);
				setTestingConfigId(null);

				if (result.success && result.result) {
					return { success: true, result: result.result };
				} else {
					return { success: false, error: result.error || 'Connection test failed' };
				}
			} catch (err) {
				console.error('[useSshRemotes] Failed to test connection:', err);
				setTestingConfigId(null);
				const errorMsg = err instanceof Error ? err.message : 'Connection test failed';
				return { success: false, error: errorMsg };
			}
		},
		[]
	);

	return {
		// State
		configs,
		defaultId,
		loading,
		error,

		// CRUD Operations
		saveConfig,
		deleteConfig,
		refresh,

		// Default Management
		setDefaultId,

		// Connection Testing
		testConnection,
		testingConfigId,
	};
}
