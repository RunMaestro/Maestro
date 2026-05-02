/**
 * IPC handlers for per-project role slot roster (#429).
 *
 * Channels:
 *   projectRoles:get  (projectPath: string) → ProjectRoleSlots
 *   projectRoles:set  (projectPath: string, slots: ProjectRoleSlots) → void
 *
 * Persistence: electron-store keyed by projectPath under the top-level key
 * "projectRoleSlots" in the settings store.
 */

import { ipcMain } from 'electron';
import type Store from 'electron-store';
import type { ProjectRoleSlots } from '../../../shared/project-roles-types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[IPC:ProjectRoles]';

/** The top-level key used inside the settings store for this data. */
const STORE_KEY = 'projectRoleSlots';

type ProjectRoleSlotsMap = Record<string, ProjectRoleSlots>;

export function registerProjectRolesHandlers(settingsStore: Store): void {
	ipcMain.handle('projectRoles:get', async (_event, projectPath: string) => {
		try {
			const map = (settingsStore.get(STORE_KEY, {}) as ProjectRoleSlotsMap) ?? {};
			const slots: ProjectRoleSlots = map[projectPath] ?? {};
			return { success: true, data: slots };
		} catch (err) {
			logger.error(`projectRoles:get error for ${projectPath}: ${err}`, LOG_CONTEXT);
			return { success: false, error: String(err) };
		}
	});

	ipcMain.handle('projectRoles:list', async () => {
		try {
			const map = (settingsStore.get(STORE_KEY, {}) as ProjectRoleSlotsMap) ?? {};
			return { success: true, data: map };
		} catch (err) {
			logger.error(`projectRoles:list error: ${err}`, LOG_CONTEXT);
			return { success: false, error: String(err) };
		}
	});

	ipcMain.handle(
		'projectRoles:set',
		async (_event, projectPath: string, slots: ProjectRoleSlots) => {
			try {
				// Runner can be SSH-remote — projects whose source lives on a remote
				// host need the runner to spawn there. SSH wrapping happens in
				// slot-executor via wrapSpawnWithSsh.
				const map = (settingsStore.get(STORE_KEY, {}) as ProjectRoleSlotsMap) ?? {};
				const updated: ProjectRoleSlotsMap = { ...map, [projectPath]: slots };
				settingsStore.set(STORE_KEY, updated);
				return { success: true };
			} catch (err) {
				logger.error(`projectRoles:set error for ${projectPath}: ${err}`, LOG_CONTEXT);
				return { success: false, error: String(err) };
			}
		}
	);

	logger.info('Project Roles IPC handlers registered', LOG_CONTEXT);
}
