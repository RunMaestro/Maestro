/**
 * Git Integration Module
 *
 * Hooks for git status tracking and file tree management.
 */

// Git status polling
export { useGitStatusPolling } from './useGitStatusPolling';
export type {
	UseGitStatusPollingReturn,
	UseGitStatusPollingOptions,
	GitStatusData,
	GitFileChange,
} from './useGitStatusPolling';

// File tree state management
export { useFileTreeManagement } from './useFileTreeManagement';
export type {
	UseFileTreeManagementDeps,
	UseFileTreeManagementReturn,
	RightPanelHandle,
} from './useFileTreeManagement';
