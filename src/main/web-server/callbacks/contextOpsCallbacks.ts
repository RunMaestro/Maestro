import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { requestFromRenderer } from './remoteRequest';
import {
	TAB_CONTEXT_OP_REPLY_MS,
	normalizeTabContextOpResult,
	type TabContextOp,
	type TabContextOpRequest,
	type TabContextOpResult,
} from '../../../shared/tabContextOps';

/** The renderer channel each operation is forwarded on. */
const RENDERER_CHANNELS: Record<TabContextOp, string> = {
	compact: 'remote:summarizeContext',
	merge: 'remote:mergeContext',
	transfer: 'remote:transferContext',
};

/**
 * Forward the AI tab overlay menu's context operations (Compact, Merge Into,
 * Send to Agent) to the renderer that owns the source agent, which runs the
 * menu's own handlers and answers with a structured result.
 */
export function registerContextOpsCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow' | 'getWindowForSession'>
): void {
	const { getMainWindow, getWindowForSession } = deps;

	server.setTabContextOpCallback(async (request: TabContextOpRequest) => {
		const targetWindow = getWindowForSession?.(request.sessionId) ?? getMainWindow();
		if (!targetWindow || !isWebContentsAvailable(targetWindow)) {
			logger.warn(`No owning window is available for context ${request.op}`, 'WebServer');
			return { success: false, error: 'Maestro window is not available' };
		}
		const budgetMs = TAB_CONTEXT_OP_REPLY_MS[request.op];
		// A miss RESOLVES, flagged `timedOut`, rather than reading as a failure:
		// the renderer may still be summarizing, and the caller must be able to
		// tell "still running" from "refused".
		const fallback: TabContextOpResult = {
			success: false,
			timedOut: true,
			error: `Maestro did not finish the context ${request.op} within ${Math.round(budgetMs / 1000)}s; it may still be running`,
		};
		return requestFromRenderer<TabContextOpResult>(targetWindow, RENDERER_CHANNELS[request.op], {
			fallback,
			parse: normalizeTabContextOpResult,
			timeoutMs: budgetMs,
			args: [request],
		});
	});
}
