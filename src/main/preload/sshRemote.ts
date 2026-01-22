/**
 * Preload API for SSH remote operations
 *
 * Provides the window.maestro.sshRemote namespace for:
 * - SSH remote configuration management
 * - SSH connection testing
 * - SSH config file parsing
 */

import { ipcRenderer } from 'electron';

/**
 * SSH remote configuration
 */
export interface SshRemoteConfig {
	id: string;
	name: string;
	host: string;
	port: number;
	username: string;
	privateKeyPath: string;
	remoteEnv?: Record<string, string>;
	enabled: boolean;
}

/**
 * SSH config host entry
 */
export interface SshConfigHost {
	host: string;
	hostName?: string;
	port?: number;
	user?: string;
	identityFile?: string;
	proxyJump?: string;
}

/**
 * Creates the SSH remote API object for preload exposure
 */
export function createSshRemoteApi() {
	return {
		saveConfig: (config: {
			id?: string;
			name?: string;
			host?: string;
			port?: number;
			username?: string;
			privateKeyPath?: string;
			remoteEnv?: Record<string, string>;
			enabled?: boolean;
		}) => ipcRenderer.invoke('ssh-remote:saveConfig', config),

		deleteConfig: (id: string) => ipcRenderer.invoke('ssh-remote:deleteConfig', id),

		getConfigs: () => ipcRenderer.invoke('ssh-remote:getConfigs'),

		getDefaultId: () => ipcRenderer.invoke('ssh-remote:getDefaultId'),

		setDefaultId: (id: string | null) => ipcRenderer.invoke('ssh-remote:setDefaultId', id),

		test: (configOrId: string | SshRemoteConfig, agentCommand?: string) =>
			ipcRenderer.invoke('ssh-remote:test', configOrId, agentCommand),

		getSshConfigHosts: (): Promise<{
			success: boolean;
			hosts: SshConfigHost[];
			error?: string;
			configPath: string;
		}> => ipcRenderer.invoke('ssh-remote:getSshConfigHosts'),
	};
}

export type SshRemoteApi = ReturnType<typeof createSshRemoteApi>;
