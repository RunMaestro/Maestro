/**
 * SSH Remote IPC Handlers
 *
 * Provides IPC handlers for managing SSH remote configurations:
 * - Save (create/update) SSH remote configurations
 * - Delete SSH remote configurations
 * - Get all SSH remote configurations
 * - Get/set the global default SSH remote ID
 * - Test SSH remote connections
 * - Parse SSH config file (~/.ssh/config)
 */

import { ipcMain } from 'electron';
import Store from 'electron-store';
import * as crypto from 'crypto';
import { SshRemoteConfig, SshRemoteTestResult } from '../../../shared/types';
import { sshRemoteManager } from '../../ssh-remote-manager';
import { createIpcHandler, CreateHandlerOptions } from '../../utils/ipcHandler';
import { logger } from '../../utils/logger';
import { MaestroSettings } from './persistence';
import { parseSshConfig, SshConfigParseResult } from '../../utils/ssh-config-parser';

const LOG_CONTEXT = '[SshRemote]';

/**
 * Helper to create handler options with consistent context
 */
const handlerOpts = (operation: string, logSuccess = true): CreateHandlerOptions => ({
	context: LOG_CONTEXT,
	operation,
	logSuccess,
});

/**
 * Dependencies required for SSH remote handler registration
 */
export interface SshRemoteHandlerDependencies {
	/** The settings store (MaestroSettings) */
	settingsStore: Store<MaestroSettings>;
}

/**
 * Get SSH remotes from store
 */
function getSshRemotes(store: Store<MaestroSettings>): SshRemoteConfig[] {
	return store.get('sshRemotes', []);
}

/**
 * Save SSH remotes to store
 */
function setSshRemotes(store: Store<MaestroSettings>, remotes: SshRemoteConfig[]): void {
	store.set('sshRemotes', remotes);
}

/**
 * Get default SSH remote ID from store
 */
function getDefaultSshRemoteId(store: Store<MaestroSettings>): string | null {
	return store.get('defaultSshRemoteId', null);
}

/**
 * Set default SSH remote ID in store
 */
function setDefaultSshRemoteId(store: Store<MaestroSettings>, id: string | null): void {
	store.set('defaultSshRemoteId', id);
}

/**
 * Register all SSH remote IPC handlers.
 *
 * Handlers:
 * - ssh-remote:saveConfig - Create or update an SSH remote configuration
 * - ssh-remote:deleteConfig - Delete an SSH remote configuration by ID
 * - ssh-remote:getConfigs - Get all SSH remote configurations
 * - ssh-remote:getDefaultId - Get the global default SSH remote ID
 * - ssh-remote:setDefaultId - Set the global default SSH remote ID
 * - ssh-remote:test - Test an SSH remote connection
 */
export function registerSshRemoteHandlers(deps: SshRemoteHandlerDependencies): void {
	const { settingsStore } = deps;

	/**
	 * Save (create or update) an SSH remote configuration.
	 *
	 * If config.id is provided and exists, updates the existing config.
	 * If config.id is not provided or doesn't exist, creates a new config with generated ID.
	 *
	 * Validates the configuration before saving.
	 */
	ipcMain.handle(
		'ssh-remote:saveConfig',
		createIpcHandler(
			handlerOpts('saveConfig'),
			async (config: Partial<SshRemoteConfig>): Promise<{ config: SshRemoteConfig }> => {
				const remotes = getSshRemotes(settingsStore);

				// Determine if this is an update or create
				const existingIndex = config.id ? remotes.findIndex((r) => r.id === config.id) : -1;
				const isUpdate = existingIndex !== -1;

				// Build the complete config
				const completeConfig: SshRemoteConfig = {
					id: config.id || crypto.randomUUID(),
					name: config.name || 'Unnamed Remote',
					host: config.host || '',
					port: config.port ?? 22,
					username: config.username || '',
					privateKeyPath: config.privateKeyPath || '',
					remoteEnv: config.remoteEnv,
					enabled: config.enabled ?? true,
					useSshConfig: config.useSshConfig,
					sshConfigHost: config.sshConfigHost,
				};

				// Validate the configuration
				const validation = sshRemoteManager.validateConfig(completeConfig);
				if (!validation.valid) {
					throw new Error(`Invalid configuration: ${validation.errors.join('; ')}`);
				}

				if (isUpdate) {
					// Update existing config
					remotes[existingIndex] = completeConfig;
					logger.info(
						`Updated SSH remote "${completeConfig.name}" (${completeConfig.id})`,
						LOG_CONTEXT
					);
				} else {
					// Add new config
					remotes.push(completeConfig);
					logger.info(
						`Created SSH remote "${completeConfig.name}" (${completeConfig.id})`,
						LOG_CONTEXT
					);
				}

				setSshRemotes(settingsStore, remotes);

				return { config: completeConfig };
			}
		)
	);

	/**
	 * Delete an SSH remote configuration by ID.
	 *
	 * Also clears the default ID if it matches the deleted config.
	 */
	ipcMain.handle(
		'ssh-remote:deleteConfig',
		createIpcHandler(
			handlerOpts('deleteConfig'),
			async (id: string): Promise<Record<string, never>> => {
				const remotes = getSshRemotes(settingsStore);
				const index = remotes.findIndex((r) => r.id === id);

				if (index === -1) {
					throw new Error(`SSH remote not found: ${id}`);
				}

				const deletedName = remotes[index].name;
				remotes.splice(index, 1);
				setSshRemotes(settingsStore, remotes);

				// Clear default if it was the deleted config
				const defaultId = getDefaultSshRemoteId(settingsStore);
				if (defaultId === id) {
					setDefaultSshRemoteId(settingsStore, null);
					logger.info(`Cleared default SSH remote (was ${id})`, LOG_CONTEXT);
				}

				logger.info(`Deleted SSH remote "${deletedName}" (${id})`, LOG_CONTEXT);

				return {};
			}
		)
	);

	/**
	 * Get all SSH remote configurations.
	 */
	ipcMain.handle(
		'ssh-remote:getConfigs',
		createIpcHandler(
			handlerOpts('getConfigs', false),
			async (): Promise<{ configs: SshRemoteConfig[] }> => {
				const remotes = getSshRemotes(settingsStore);
				return { configs: remotes };
			}
		)
	);

	/**
	 * Get the global default SSH remote ID.
	 */
	ipcMain.handle(
		'ssh-remote:getDefaultId',
		createIpcHandler(
			handlerOpts('getDefaultId', false),
			async (): Promise<{ id: string | null }> => {
				const defaultId = getDefaultSshRemoteId(settingsStore);
				return { id: defaultId };
			}
		)
	);

	/**
	 * Set the global default SSH remote ID.
	 *
	 * Pass null to clear the default.
	 * Validates that the ID exists in the stored configs.
	 */
	ipcMain.handle(
		'ssh-remote:setDefaultId',
		createIpcHandler(
			handlerOpts('setDefaultId'),
			async (id: string | null): Promise<Record<string, never>> => {
				if (id !== null) {
					// Validate that the ID exists
					const remotes = getSshRemotes(settingsStore);
					const exists = remotes.some((r) => r.id === id);
					if (!exists) {
						throw new Error(`SSH remote not found: ${id}`);
					}
				}

				setDefaultSshRemoteId(settingsStore, id);
				logger.info(`Set default SSH remote to ${id ?? 'none'}`, LOG_CONTEXT);

				return {};
			}
		)
	);

	/**
	 * Test an SSH remote connection.
	 *
	 * Accepts either a config ID (to test stored config) or a full config object
	 * (to test before saving).
	 */
	ipcMain.handle(
		'ssh-remote:test',
		createIpcHandler(
			handlerOpts('test'),
			async (
				configOrId: string | SshRemoteConfig,
				agentCommand?: string
			): Promise<{ result: SshRemoteTestResult }> => {
				let config: SshRemoteConfig;

				if (typeof configOrId === 'string') {
					// Lookup by ID
					const remotes = getSshRemotes(settingsStore);
					const found = remotes.find((r) => r.id === configOrId);
					if (!found) {
						throw new Error(`SSH remote not found: ${configOrId}`);
					}
					config = found;
				} else {
					// Use provided config directly
					config = configOrId;
				}

				logger.info(`Testing SSH connection to ${config.host}...`, LOG_CONTEXT);
				const result = await sshRemoteManager.testConnection(config, agentCommand);

				if (result.success) {
					logger.info(
						`SSH connection test successful: ${result.remoteInfo?.hostname || 'unknown host'}`,
						LOG_CONTEXT
					);
				} else {
					logger.warn(`SSH connection test failed: ${result.error}`, LOG_CONTEXT);
				}

				return { result };
			}
		)
	);

	/**
	 * Get SSH hosts from ~/.ssh/config file.
	 *
	 * Parses the user's SSH config file and returns available host entries.
	 * This allows auto-filling connection details from existing SSH configurations.
	 */
	ipcMain.handle(
		'ssh-remote:getSshConfigHosts',
		createIpcHandler(handlerOpts('getSshConfigHosts', false), async () => {
			const result = parseSshConfig();
			if (result.success) {
				logger.debug(`Found ${result.hosts.length} hosts in SSH config`, LOG_CONTEXT);
			} else {
				logger.warn(`Failed to parse SSH config: ${result.error}`, LOG_CONTEXT);
			}
			return result as SshConfigParseResult & Record<string, unknown>;
		})
	);

	logger.debug(`${LOG_CONTEXT} SSH remote IPC handlers registered`);
}
