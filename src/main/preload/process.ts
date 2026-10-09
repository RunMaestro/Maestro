/**
 * Preload API for process management
 *
 * Provides the window.maestro.process namespace for:
 * - Spawning and managing agent/terminal processes
 * - Writing to processes
 * - Handling process events (data, exit, errors)
 * - Remote command execution from web interface
 * - SSH remote execution support
 */

import { createProcessCoreApi } from './process/core';
import { createCommandRemoteApi } from './process/commandRemote';
import { createTabRemoteApi } from './process/tabRemote';
import { createNotificationRemoteApi } from './process/notificationRemote';
import { createCadenzaMovementRemoteApi } from './process/cadenzaMovementRemote';
import { createBrowserTabRemoteApi } from './process/browserTabRemote';
import { createQueueRemoteApi } from './process/queueRemote';
import { createGistRemoteApi } from './process/gistRemote';
import { createCueRemoteApi } from './process/cueRemote';
import { createAutoRunConfigRemoteApi } from './process/autoRunConfigRemote';
import { createAutoRunControlRemoteApi } from './process/autoRunControlRemote';
import { createPlaybookRemoteApi } from './process/playbookRemote';
import { createSessionCrudRemoteApi } from './process/sessionCrudRemote';
import { createGroupCrudRemoteApi } from './process/groupCrudRemote';
import { createGitRemoteApi } from './process/gitRemote';
import { createGroupChatRemoteApi } from './process/groupChatRemote';
import { createContextOpsRemoteApi } from './process/contextOpsRemote';
import { createSettingsRemoteApi } from './process/settingsRemote';

// Re-export for consumers that import from preload
export type { UsageStats } from '../../shared/types';
export type {
	ProcessConfig,
	ProcessSpawnResponse,
	RunCommandConfig,
	ActiveProcess,
	AgentError,
	ToolExecutionEvent,
	ProcessUserInputBroadcast,
	SshRemoteInfo,
} from './process/core';

/**
 * Creates the process API object for preload exposure
 */
export function createProcessApi() {
	return {
		...createProcessCoreApi(),
		...createCommandRemoteApi(),
		...createTabRemoteApi(),
		...createNotificationRemoteApi(),
		...createCadenzaMovementRemoteApi(),
		...createBrowserTabRemoteApi(),
		...createQueueRemoteApi(),
		...createAutoRunConfigRemoteApi(),
		...createSessionCrudRemoteApi(),
		...createAutoRunControlRemoteApi(),
		...createPlaybookRemoteApi(),
		...createSettingsRemoteApi(),
		...createGroupCrudRemoteApi(),

		...createGitRemoteApi(),
		...createGroupChatRemoteApi(),
		...createContextOpsRemoteApi(),
		...createGistRemoteApi(),
		...createCueRemoteApi(),
	};
}

/**
 * TypeScript type for the process API
 */
export type ProcessApi = ReturnType<typeof createProcessApi>;
