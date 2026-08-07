/**
 * Maps raw persisted sessions into the shape the group-chat router needs to
 * resolve @mention auto-add targets.
 *
 * Extracted verbatim out of main/index.ts's setupIpcHandlers()
 * (setGetSessionsCallback) - the one piece of real logic in that function,
 * isolated here for reviewability (Phase 5 refactoring).
 */

import os from 'os';
import type { getSshRemoteById } from '../../stores';

export function mapSessionsForMentions(
	sessions: any[],
	getSshRemoteByIdFn: typeof getSshRemoteById
) {
	return sessions.map((s: any) => {
		// Resolve SSH remote name if session has SSH config
		let sshRemoteName: string | undefined;
		if (s.sessionSshRemoteConfig?.enabled && s.sessionSshRemoteConfig.remoteId) {
			const sshConfig = getSshRemoteByIdFn(s.sessionSshRemoteConfig.remoteId);
			sshRemoteName = sshConfig?.name;
		}
		return {
			id: s.id,
			name: s.name,
			toolType: s.toolType,
			cwd: s.cwd || s.fullPath || os.homedir(),
			customArgs: s.customArgs,
			customEnvVars: s.customEnvVars,
			customModel: s.customModel,
			// Claude token-source selection, so group chat participants honor
			// the same maestro-p TUI / API / dynamic choice as their agent.
			enableMaestroP: s.enableMaestroP,
			maestroPMode: s.maestroPMode,
			maestroPPath: s.maestroPPath,
			sshRemoteName,
			// Pass full SSH config for remote execution support
			sshRemoteConfig: s.sessionSshRemoteConfig,
			autoRunFolderPath: s.autoRunFolderPath,
			worktreeBasePath: s.worktreeConfig?.basePath,
		};
	});
}
