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
	AgentCapabilitiesData,
	WindowState,
	ClaudeSessionOriginsData,
	AgentSessionOriginsData,
} from './types';
import type { SshRemoteConfig } from '../../shared/types';

import { isInitialized, getStoreInstances, getCachedPaths } from './instances';
import { logger } from '../utils/logger';

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

export function getAgentCapabilitiesStore(): Store<AgentCapabilitiesData> {
	ensureInitialized();
	return getStoreInstances().agentCapabilitiesStore!;
}

export function getWindowStateStore(): Store<WindowState> {
	ensureInitialized();
	return getStoreInstances().windowStateStore!;
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

/** Logged at most once per process - see getSshRemoteById. */
let warnedAboutMalformedSshRemotes = false;

/**
 * Get SSH remote configuration by ID from the settings store.
 * Returns undefined if not found.
 *
 * `settings.json` is a plain file in userData that users hand-edit and that
 * sync tools rewrite, and electron-store only substitutes the `[]` default when
 * the key is absent - not when it holds a non-array. A malformed value used to
 * take down every caller with `sshRemotes.find is not a function`, including
 * the Right Bar's git:status/git:numstat polls on agents that use no SSH remote
 * at all (MAESTRO-YB/YC). Treat an unusable value as "no remotes configured"
 * and warn once so the bad file is still diagnosable.
 */
export function getSshRemoteById(sshRemoteId: string): SshRemoteConfig | undefined {
	const sshRemotes = getSettingsStore().get('sshRemotes', []);
	if (!Array.isArray(sshRemotes)) {
		if (!warnedAboutMalformedSshRemotes) {
			warnedAboutMalformedSshRemotes = true;
			logger.warn(
				`Ignoring malformed 'sshRemotes' setting (expected an array, got ${typeof sshRemotes})`,
				'Settings'
			);
		}
		return undefined;
	}
	return sshRemotes.find((r) => r.id === sshRemoteId);
}
