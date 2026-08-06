/**
 * Git Integration Module
 *
 * Hooks for git status tracking and file tree management.
 */

// Git status polling
export { useGitStatusPolling, getScaledPollInterval } from './useGitStatusPolling';
export type {
	UseGitStatusPollingReturn,
	UseGitStatusPollingOptions,
	GitStatusData,
	GitFileChange,
} from './useGitStatusPolling';

// Per-agent git actions shared by the header pill menu and the Left Bar menu
export { useGitAgentActions, resolveGitCwd, resolveGitSshRemoteId } from './useGitAgentActions';
export type { GitAgentActions } from './useGitAgentActions';

// File tree state management
export { useFileTreeManagement } from './useFileTreeManagement';
export type {
	UseFileTreeManagementDeps,
	UseFileTreeManagementReturn,
	RightPanelHandle,
} from './useFileTreeManagement';

// File explorer effects & keyboard navigation (Phase 2.6)
export { useFileExplorerEffects } from './useFileExplorerEffects';
export type {
	UseFileExplorerEffectsDeps,
	UseFileExplorerEffectsReturn,
} from './useFileExplorerEffects';
