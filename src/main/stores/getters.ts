/**
 * Store Getters
 *
 * Public getter functions for accessing store instances.
 * All getters throw if stores haven't been initialized.
 */

import type Store from 'electron-store';

import type {
	BootstrapSettings,
	MaestroSettings,
	SessionsData,
	GroupsData,
	AgentConfigsData,
	WindowState,
	MultiWindowStoreData,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
} from './types';
import type { SshRemoteConfig } from '../../shared/types';

import { isInitialized, getStoreInstances, getCachedPaths } from './instances';

// ============================================================================
// Initialization Check
// ============================================================================

function ensureInitialized(): void {
	if (!isInitialized()) {
		throw new Error('Stores not initialized. Call initializeStores() first.');
	}
}

// ============================================================================
// Store Getters
// ============================================================================

export function getBootstrapStore(): Store<BootstrapSettings> {
	const { bootstrapStore } = getStoreInstances();
	if (!bootstrapStore) {
		throw new Error('Stores not initialized. Call initializeStores() first.');
	}
	return bootstrapStore;
}

export function getSettingsStore(): Store<MaestroSettings> {
	ensureInitialized();
	return getStoreInstances().settingsStore!;
}

export function getSessionsStore(): Store<SessionsData> {
	ensureInitialized();
	return getStoreInstances().sessionsStore!;
}

export function getGroupsStore(): Store<GroupsData> {
	ensureInitialized();
	return getStoreInstances().groupsStore!;
}

export function getAgentConfigsStore(): Store<AgentConfigsData> {
	ensureInitialized();
	return getStoreInstances().agentConfigsStore!;
}

export function getWindowStateStore(): Store<WindowState> {
	ensureInitialized();
	return getStoreInstances().windowStateStore!;
}

export function getMultiWindowStateStore(): Store<MultiWindowStoreData> {
	ensureInitialized();
	return getStoreInstances().multiWindowStateStore!;
}

export function getClaudeSessionOriginsStore(): Store<ClaudeSessionOriginsData> {
	ensureInitialized();
	return getStoreInstances().claudeSessionOriginsStore!;
}

export function getAgentSessionOriginsStore(): Store<AgentSessionOriginsData> {
	ensureInitialized();
	return getStoreInstances().agentSessionOriginsStore!;
}

// ============================================================================
// Path Getters
// ============================================================================

/**
 * Get the sync path. Must be called after initializeStores().
 */
export function getSyncPath(): string {
	const { syncPath } = getCachedPaths();
	if (syncPath === null) {
		throw new Error('Stores not initialized. Call initializeStores() first.');
	}
	return syncPath;
}

/**
 * Get the production data path. Must be called after initializeStores().
 */
export function getProductionDataPath(): string {
	const { productionDataPath } = getCachedPaths();
	if (productionDataPath === null) {
		throw new Error('Stores not initialized. Call initializeStores() first.');
	}
	return productionDataPath;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found.
 */
export function getSshRemoteById(sshRemoteId: string): SshRemoteConfig | undefined {
	const sshRemotes = getSettingsStore().get('sshRemotes', []);
	return sshRemotes.find((r) => r.id === sshRemoteId);
}
