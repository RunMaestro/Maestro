/**
 * Computer History - route a digest ask through the cross-agent consult path.
 *
 * The consult (`maestro-cli ask`, a typed @mention) is owned by the renderer:
 * it opens the hidden consult tab on the target agent, resumes its provider
 * session, and answers with the reply text. The WS bridge reaches it with
 * `requestFromRenderer(window, 'remote:crossAgentAsk', ...)`; digests make the
 * identical call from main so there is exactly one way to ask an agent.
 */

import type { BrowserWindow } from 'electron';
import { requestFromRenderer } from '../web-server/callbacks/remoteRequest';
import { parseConsultAgentResult } from '../web-server/callbacks/commandCallbacks';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { ConsultAgentResult } from '../web-server/types';
import type { DigestConsult } from './digests';

export function createDigestConsult(
	getWindowForSession: (sessionId: string) => BrowserWindow | null
): DigestConsult {
	return async ({ targetSessionId, question, timeoutMs }) => {
		const win = getWindowForSession(targetSessionId);
		if (!win || !isWebContentsAvailable(win)) {
			return { success: false, error: 'No Maestro window is available' };
		}
		const result = await requestFromRenderer<ConsultAgentResult>(win, 'remote:crossAgentAsk', {
			fallback: {
				success: false,
				error: `The digest agent did not answer within ${Math.round(timeoutMs / 1000)}s`,
			},
			timeoutMs,
			parse: parseConsultAgentResult,
			args: [{ targetSessionId, question, withContext: false }],
		});
		return { success: result.success, answer: result.answer, error: result.error };
	};
}
