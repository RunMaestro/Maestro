/**
 * Computer History IPC (`computerHistory:*`).
 *
 * Thin pass-throughs to the one ComputerHistoryService (the CLI's WS writes
 * reach the same instance). DESKTOP-ONLY: every `computerHistory:` channel is
 * on BRIDGE_DENIED_CHANNELS (D15), so a browser cannot call these verbs
 * through `bridge.invoke`. The store FILES are guarded separately: for web
 * clients, bridgePathGuard.ts refuses any bridge call whose arguments point
 * inside the store or at the CLI discovery file, and any write that would
 * flip the Computer History flag.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import { getComputerHistoryService } from '../../computer-history';
import type { ComputerHistoryService } from '../../computer-history';
import { compileGrep } from '../../../shared/computer-history/reader';
import type { ComputerHistoryConfigPatch } from '../../../shared/computer-history/config';
import type { CaptureRuleMatch, StoredEventKind } from '../../../shared/computer-history/types';

const LOG_CONTEXT = '[ComputerHistory]';

/** Query payload over IPC: a RegExp cannot cross the boundary, so grep is a string. */
export interface ComputerHistoryQueryRequest {
	sinceMs?: number;
	untilMs?: number;
	apps?: string[];
	kinds?: StoredEventKind[];
	grep?: string;
	limit?: number;
}

function requireService(): ComputerHistoryService {
	const service = getComputerHistoryService();
	if (!service) throw new Error('Computer History is not available in this session');
	return service;
}

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

export function registerComputerHistoryHandlers(): void {
	ipcMain.handle(
		'computerHistory:status',
		withIpcErrorLogging(opts('status'), async () => requireService().status())
	);
	ipcMain.handle(
		'computerHistory:getConfig',
		withIpcErrorLogging(opts('getConfig'), async () => requireService().getConfig())
	);
	ipcMain.handle(
		'computerHistory:setConfig',
		withIpcErrorLogging(opts('setConfig'), async (patch: ComputerHistoryConfigPatch) =>
			requireService().setConfig(patch ?? {})
		)
	);
	ipcMain.handle(
		'computerHistory:pause',
		withIpcErrorLogging(opts('pause'), async (forMs?: number | null) =>
			requireService().pause(forMs)
		)
	);
	ipcMain.handle(
		'computerHistory:resume',
		withIpcErrorLogging(opts('resume'), async () => requireService().resume())
	);
	ipcMain.handle(
		'computerHistory:listRules',
		withIpcErrorLogging(opts('listRules'), async () => requireService().listRules())
	);
	ipcMain.handle(
		'computerHistory:addRule',
		withIpcErrorLogging(opts('addRule'), async (match: CaptureRuleMatch, value: string) =>
			requireService().addRule(match, value)
		)
	);
	ipcMain.handle(
		'computerHistory:removeRule',
		withIpcErrorLogging(opts('removeRule'), async (idOrValue: string) =>
			requireService().removeRule(idOrValue)
		)
	);
	ipcMain.handle(
		'computerHistory:clear',
		withIpcErrorLogging(opts('clear'), async (options: { sinceMs?: number; all?: boolean }) =>
			requireService().clear(options ?? {})
		)
	);
	ipcMain.handle(
		'computerHistory:requestAccessibility',
		withIpcErrorLogging(opts('requestAccessibility'), async () =>
			requireService().requestAccessibility()
		)
	);
	ipcMain.handle(
		'computerHistory:query',
		withIpcErrorLogging(opts('query'), async (request: ComputerHistoryQueryRequest) => {
			const r = request ?? {};
			return requireService().query({
				sinceMs: r.sinceMs,
				untilMs: r.untilMs,
				apps: r.apps,
				kinds: r.kinds,
				grep: compileGrep(r.grep),
				limit: r.limit,
			});
		})
	);
}
