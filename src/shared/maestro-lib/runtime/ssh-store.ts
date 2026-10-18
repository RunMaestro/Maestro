/**
 * The stored SSH remotes, as the launch code asks for them.
 *
 * Read when a turn starts, not once, so an edit made in the desktop applies to the next turn.
 * Chat turns and Auto Run turns both launch through `runAgentTurn`, which resolves a remote from
 * this store, so they share it.
 */

import type { SshRemoteConfig } from '../../types';
import type { SshRemoteSettingsStore } from '../launch/ssh-remote-resolver';
import type { MaestroPaths } from '../paths/resolve';
import { readSettingsStore } from '../store/read-stores';

export function createSshRemoteStore(
	paths: Pick<MaestroPaths, 'settingsFile'>
): SshRemoteSettingsStore {
	return {
		getSshRemotes: () => {
			const read = readSettingsStore(paths.settingsFile);
			const remotes = read.status === 'ok' ? read.data.sshRemotes : undefined;
			return Array.isArray(remotes) ? (remotes as SshRemoteConfig[]) : [];
		},
	};
}
