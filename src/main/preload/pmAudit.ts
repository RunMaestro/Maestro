/**
 * Preload API for the pm-audit IPC channel (#434).
 *
 * Exposes `window.maestro.pmAudit.run()` so the renderer can trigger a full
 * audit sweep of in-flight work items without touching ipcRenderer directly.
 */

import { ipcRenderer } from 'electron';
import type { PmAuditRunOptions } from '../ipc/handlers/pm-audit';
import type { AuditReport } from '../pm-audit/audit-runner';

export function createPmAuditApi() {
	return {
		/**
		 * Run the full 7-check audit sweep over all non-archived work items.
		 *
		 * @param opts - Optional overrides (staleClaimMs, projectRoleSlots).
		 * @returns A structured AuditReport with autoFixed and needsAttention findings.
		 */
		run: (
			opts?: PmAuditRunOptions
		): Promise<{ success: true; data: AuditReport } | { success: false; error: string }> =>
			ipcRenderer.invoke('pmAudit:run', opts ?? {}),
	};
}

export type PmAuditApi = ReturnType<typeof createPmAuditApi>;
