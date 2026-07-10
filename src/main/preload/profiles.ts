/**
 * Preload API for Agent Profiles operations
 *
 * Provides the window.maestro.profiles namespace for listing/creating/updating/
 * deleting Agent Profiles for the current project. A Profile is a named override
 * bundle (model / effort / role prompt / extra args) layered on a base agent.
 */

import { ipcRenderer } from 'electron';
import type { AgentProfile } from '../../shared/profiles/types';

export type { AgentProfile } from '../../shared/profiles/types';

/**
 * Creates the Profiles API object for preload exposure.
 */
export function createProfilesApi() {
	return {
		// List all profiles for a project.
		list: (projectRoot: string): Promise<AgentProfile[]> =>
			ipcRenderer.invoke('profiles:list', { projectRoot }),

		// Create or update a profile (upsert by id). Returns the updated list.
		upsert: (projectRoot: string, profile: AgentProfile): Promise<AgentProfile[]> =>
			ipcRenderer.invoke('profiles:upsert', { projectRoot, profile }),

		// Delete a profile by id. Returns the updated list.
		delete: (projectRoot: string, profileId: string): Promise<AgentProfile[]> =>
			ipcRenderer.invoke('profiles:delete', { projectRoot, profileId }),
	};
}

export type ProfilesApi = ReturnType<typeof createProfilesApi>;
