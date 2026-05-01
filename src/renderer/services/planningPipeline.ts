/**
 * Planning Pipeline renderer service
 *
 * Thin wrapper around window.maestro.pipeline that unwraps the
 * { success, data } IPC envelope and throws on failure so callers can rely on
 * normal async/await error handling.
 */

import type { PipelineDashboardResult } from '../../main/ipc/handlers/planning-pipeline';

type IpcResponse<T> = { success: true; data: T } | { success: false; error: string };

const unwrap = async <T>(response: Promise<IpcResponse<T>>): Promise<T> => {
	const result = await response;
	if (!result.success) {
		throw new Error(result.error);
	}
	return result.data;
};

export const planningPipelineService = {
	/**
	 * Fetch the full pipeline dashboard snapshot.
	 * Items are grouped by stage; items with no pipeline label land in `unstaged`.
	 */
	getDashboard: (): Promise<PipelineDashboardResult> =>
		unwrap(window.maestro.pipeline.getDashboard()),
};
