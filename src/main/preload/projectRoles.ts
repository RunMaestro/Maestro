/**
 * Preload API for per-project role slot roster (#429).
 *
 * Provides the window.maestro.projectRoles namespace.
 */

import { ipcRenderer } from 'electron';
import type { ProjectRoleSlots } from '../../shared/project-roles-types';

export function createProjectRolesApi() {
	return {
		get: (
			projectPath: string
		): Promise<{ success: true; data: ProjectRoleSlots } | { success: false; error: string }> =>
			ipcRenderer.invoke('projectRoles:get', projectPath),

		set: (
			projectPath: string,
			slots: ProjectRoleSlots
		): Promise<{ success: true } | { success: false; error: string }> =>
			ipcRenderer.invoke('projectRoles:set', projectPath, slots),
	};
}

export type ProjectRolesApi = ReturnType<typeof createProjectRolesApi>;
