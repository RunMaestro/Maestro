/**
 * Agent Profiles IPC Handlers
 *
 * Provides IPC handlers for listing/creating/updating/deleting Agent Profiles
 * for the current project. A Profile is a named override bundle layered on an
 * existing base agent (model / effort / role prompt / extra args).
 *
 * This module is a thin transport layer: filesystem I/O and validation live in
 * the domain module (`src/main/profiles/profile-storage.ts`). Each handler is a
 * 1-line delegation, mirroring the Cue IPC handlers.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging, type CreateHandlerOptions } from '../../utils/ipcHandler';
import {
	deleteProfile,
	listProfiles,
	upsertProfile,
} from '../../profiles/profile-storage';
import type { AgentProfile } from '../../../shared/profiles/types';

const LOG_CONTEXT = '[Profiles]';

const handlerOpts = (operation: string): Pick<CreateHandlerOptions, 'context' | 'operation'> => ({
	context: LOG_CONTEXT,
	operation,
});

/**
 * Register all Agent Profiles IPC handlers. No engine/service dependency - the
 * storage layer reads/writes `.maestro/profiles.yaml` under the passed project
 * root on demand.
 */
export function registerProfileHandlers(): void {
	// List all profiles for a project.
	ipcMain.handle(
		'profiles:list',
		withIpcErrorLogging(
			handlerOpts('list'),
			async (options: { projectRoot: string }): Promise<AgentProfile[]> => {
				return listProfiles(options.projectRoot);
			}
		)
	);

	// Create or update a profile (upsert by id). Returns the full updated list.
	ipcMain.handle(
		'profiles:upsert',
		withIpcErrorLogging(
			handlerOpts('upsert'),
			async (options: {
				projectRoot: string;
				profile: AgentProfile;
			}): Promise<AgentProfile[]> => {
				return upsertProfile(options.projectRoot, options.profile);
			}
		)
	);

	// Delete a profile by id. Returns the full updated list.
	ipcMain.handle(
		'profiles:delete',
		withIpcErrorLogging(
			handlerOpts('delete'),
			async (options: { projectRoot: string; profileId: string }): Promise<AgentProfile[]> => {
				return deleteProfile(options.projectRoot, options.profileId);
			}
		)
	);
}
