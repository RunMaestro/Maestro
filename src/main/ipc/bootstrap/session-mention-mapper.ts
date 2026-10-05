/**
 * Maps raw persisted sessions into the shape the group-chat router needs to
 * resolve @mention auto-add targets.
 *
 * Extracted verbatim out of main/index.ts's setupIpcHandlers()
 * (setGetSessionsCallback). The field mapping itself is `toGroupChatSessionInfo` in
 * the library, shared with the headless runtime; this binds it to the desktop's SSH
 * remote store and live process liveness.
 */

import type { getSshRemoteById } from '../../stores';
import { isAgentBusy, type ProcessLivenessProbe } from '../../utils/agent-busy';
import { toGroupChatSessionInfo } from '../../../shared/maestro-lib/groupchat/session-info';

export function mapSessionsForMentions(
	sessions: any[],
	getSshRemoteByIdFn: typeof getSshRemoteById,
	processManager?: ProcessLivenessProbe | null
) {
	return sessions.map((s: any) => ({
		...toGroupChatSessionInfo(s, {
			sshRemoteName: (remoteId) => getSshRemoteByIdFn(remoteId)?.name,
			// Live liveness, not the persisted state: persistence rewrites every
			// session and tab to 'idle' on the way to disk, so the stored record
			// can never say whether this agent is mid-turn.
			isBusy: isAgentBusy(s, processManager),
		}),
		worktreeBasePath: s.worktreeConfig?.basePath,
	}));
}
