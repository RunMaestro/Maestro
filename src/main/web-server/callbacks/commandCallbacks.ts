import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import type { StoredSession } from '../../stores/types';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { requestFromRenderer } from './remoteRequest';
import { requestRemoteCommandReceipt } from './remoteCommandReceipt';
import { REMOTE_COMMAND_CLAIM_TIMEOUT_MS } from '../../../shared/remoteCommandReceipt';
import type { ConsultAgentResult } from '../types';
import type { ConsultChain } from '../../../shared/consultBudget';
import type { MentionRouting } from '../../../shared/crossAgentContext';
import { snapshotAiTurnProcesses, waitForAiTurnsToExit } from '../../utils/agent-busy';
import {
	INTERRUPT_TURN_EXIT_WAIT_MS,
	INTERRUPT_TURN_RENDERER_TIMEOUT_MS,
	interruptTurnFailure,
	parseInterruptTurnResult,
} from '../../../shared/turnInterrupt';

/**
 * How long to wait for the outcome of a command the renderer has claimed
 * before reporting the handover itself.
 *
 * A `maestro-cli dispatch` gives up on its own reply after 10 s
 * (`DEFAULT_COMMAND_TIMEOUT_MS` in `src/shared/maestro-lib/client/bridge-connection.ts`),
 * so the claim window plus this one must stay inside that. A turn that takes
 * longer to start (a slow `git status`, a spawn held behind a synopsis writer)
 * is reported as accepted and pending: the renderer owns it by then.
 */
const REMOTE_COMMAND_OUTCOME_TIMEOUT_MS = 4000;

/**
 * Reduce a receipt reason to its leading code for logging.
 *
 * Reasons are shaped `code` or `code:detail`, and the detail half can carry
 * remote input or an error string with paths in it. This log line is persisted
 * at warn level, so only the code - a fixed vocabulary the renderer chooses
 * from - is written (CWE-532, review of PR #1357). The detail is dropped
 * rather than truncated: half a secret is still a secret.
 */
function receiptReasonCode(reason: string | undefined): string {
	if (!reason) return 'no reason given';
	const code = reason.split(':', 1)[0].trim();
	// Guard against a reason that is entirely detail (leading colon) or that
	// smuggles whitespace/punctuation in place of a code.
	return /^[a-z0-9-]+$/i.test(code) ? code : 'unrecognized-reason';
}

/**
 * Narrow the renderer's consult reply. An older renderer that does not know the
 * channel simply never answers and the timeout fallback applies; a malformed
 * answer is reported as a failure rather than passed through as a truthy object,
 * so the calling agent never treats "no answer" as an answer.
 */
export function parseConsultAgentResult(raw: unknown): ConsultAgentResult {
	if (typeof raw !== 'object' || raw === null) {
		return { success: false, error: 'malformed-consult-result' };
	}
	const r = raw as Record<string, unknown>;
	const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
	return {
		success: r.success === true,
		answer: str(r.answer),
		error: str(r.error),
		canceled: r.canceled === true,
		targetAgentName: str(r.targetAgentName),
		targetTabId: str(r.targetTabId),
		targetToolType: str(r.targetToolType),
	};
}

export function registerCommandCallbacks(
	server: WebServer,
	deps: Pick<
		WebServerFactoryDependencies,
		'getMainWindow' | 'getWindowForSession' | 'sessionsStore' | 'getProcessManager'
	>
): void {
	const { getMainWindow, getWindowForSession, sessionsStore, getProcessManager } = deps;
	const resolveSessionWindow = (sessionId: string) =>
		getWindowForSession?.(sessionId) ?? getMainWindow();

	// Set up callback for web server to execute commands through the desktop
	// This forwards AI commands to the renderer, ensuring single source of truth
	// The renderer handles all spawn logic, state management, and broadcasts
	server.setExecuteCommandCallback(
		async (
			sessionId: string,
			command: string,
			inputMode?: 'ai' | 'terminal',
			tabId?: string,
			force?: boolean,
			images?: string[],
			background?: boolean,
			consultChain?: ConsultChain,
			mentionRouting?: MentionRouting,
			requireDeliveryReceipt?: boolean,
			pianolaDispatchId?: string
		) => {
			const targetWindow = resolveSessionWindow(sessionId);
			if (!targetWindow) {
				logger.warn('No owning window is available for executeCommand', 'WebServer');
				return false;
			}

			// Look up the session to get Claude session ID for logging
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			const agentSessionId = session?.agentSessionId || 'none';

			// Forward to renderer - it will handle spawn, state, and everything else.
			// Log metadata only at info level - remote commands can carry secrets,
			// proprietary code, or PII; the full prompt goes to debug, which is
			// only enabled by users who have explicitly opted in.
			logger.info(
				`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Tab: ${tabId || 'active'} | Force: ${force ? 'yes' : 'no'} | Focus: ${background ? 'no' : 'yes'} | Images: ${images?.length ?? 0} | CommandLength: ${command.length}`,
				'WebServer'
			);
			logger.debug(
				`[Web → Renderer] Command preview (truncated): ${command.substring(0, 100)}`,
				'WebServer'
			);
			if (!isWebContentsAvailable(targetWindow)) {
				logger.warn('webContents is not available for executeCommand', 'WebServer');
				return false;
			}
			// Wait for the renderer's delivery receipt instead of reporting
			// success for the mere fact that an IPC send was issued. `success`
			// means "the renderer accepted the command for execution" - a
			// dropped, not-found or busy command must not read as success.
			// This is delivery, not execution: the renderer reports as soon as
			// the turn starts or the prompt is queued. A renderer that never
			// claims the command never runs it, so that failure is true too.
			const receipt = await requestRemoteCommandReceipt(
				targetWindow,
				[
					sessionId,
					command,
					inputMode,
					tabId,
					force,
					images,
					background,
					consultChain,
					mentionRouting,
					...(pianolaDispatchId ? [pianolaDispatchId] : []),
				],
				{ outcomeTimeoutMs: REMOTE_COMMAND_OUTCOME_TIMEOUT_MS }
			);
			if (!receipt.accepted) {
				logger.warn(
					receipt.timedOut
						? `[Web → Renderer] No renderer claimed the command within ${REMOTE_COMMAND_CLAIM_TIMEOUT_MS}ms for session ${sessionId} - reporting dispatch as failed`
						: `[Web → Renderer] Renderer rejected command for session ${sessionId}: ${receiptReasonCode(receipt.reason)}`,
					'WebServer'
				);
			} else if (receipt.pending) {
				logger.info(
					`[Web → Renderer] Renderer claimed the command for session ${sessionId} and is still starting the turn - reporting the handover`,
					'WebServer'
				);
			}
			// An unclaimed or malformed receipt is not a refusal by the agent.
			// Scoped callers preserve the durable intent when this throws.
			if (requireDeliveryReceipt && (receipt.timedOut || receipt.reason === 'malformed-receipt')) {
				throw new Error('Renderer delivery outcome unknown');
			}
			return receipt.accepted;
		}
	);

	// Cross-agent consult (`maestro-cli ask`). Forwarded to the renderer, which
	// owns the consult path a typed `@mention` uses - the hidden tab on the
	// target, the resumed provider session, the History attribution. The wait is
	// the whole turn, so the timeout is the caller's, not the 3s delivery receipt
	// the dispatch path uses: here we are waiting for an ANSWER, not for the
	// renderer to accept a prompt.
	server.setConsultAgentCallback(async (params) => {
		const targetWindow = resolveSessionWindow(params.targetSessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for consultAgent', 'WebServer');
			return { success: false, error: 'No Maestro window is available' };
		}
		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for consultAgent', 'WebServer');
			return { success: false, error: 'No Maestro window is available' };
		}
		logger.info(
			`[Web \u2192 Renderer] Forwarding consult | Target: ${params.targetSessionId} | From: ${params.fromSessionId ?? 'unattributed'} | QuestionLength: ${params.question.length}`,
			'WebServer'
		);
		return requestFromRenderer<ConsultAgentResult>(targetWindow, 'remote:crossAgentAsk', {
			fallback: {
				success: false,
				error: `The consulted agent did not answer within ${Math.round(params.timeoutMs / 1000)}s`,
			},
			timeoutMs: params.timeoutMs,
			parse: parseConsultAgentResult,
			args: [
				{
					targetSessionId: params.targetSessionId,
					question: params.question,
					fromSessionId: params.fromSessionId,
					fromTabId: params.fromTabId,
					withContext: params.withContext,
					...(params.consultChain ? { consultChain: params.consultChain } : {}),
				},
			],
		});
	});

	// A dispatch run from an agent's own shell names its caller. The pill goes to
	// the CALLER's window, not the target's: it belongs to the conversation that
	// handed the work over.
	server.setNoteAgentDelegationCallback((notice) => {
		const callerWindow = resolveSessionWindow(notice.fromSessionId);
		if (!callerWindow || !isWebContentsAvailable(callerWindow)) {
			logger.warn('No owning window is available for noteAgentDelegation', 'WebServer');
			return;
		}
		callerWindow.webContents.send('remote:agentDelegation', notice);
	});

	// Stop a running turn through the desktop's own Stop (`interruptTurn()` in
	// the renderer), on the window that owns the agent. The renderer answers with
	// what it stopped; main then waits, bounded, for those processes to leave its
	// table, so `tab show` and `session list` read idle when the caller returns.
	server.setInterruptSessionCallback(async (sessionId: string, tabId?: string) => {
		const scopeTabId = tabId ?? null;
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow || !isWebContentsAvailable(targetWindow)) {
			logger.warn('No owning window is available for interrupt', 'WebServer');
			return interruptTurnFailure(
				sessionId,
				scopeTabId,
				'RENDERER_UNAVAILABLE',
				'No Maestro window owns this agent'
			);
		}

		const processManager = getProcessManager();
		const liveBefore = snapshotAiTurnProcesses(processManager, sessionId, scopeTabId);
		logger.debug(
			`Forwarding interrupt to renderer | session=${sessionId} | tab=${tabId ?? 'all'}`,
			'WebServer'
		);
		const result = await requestFromRenderer(targetWindow, 'remote:interrupt', {
			args: [sessionId, scopeTabId],
			parse: (raw) => parseInterruptTurnResult(raw, sessionId, scopeTabId),
			fallback: interruptTurnFailure(
				sessionId,
				scopeTabId,
				'RENDERER_TIMEOUT',
				'The Maestro window did not answer the interrupt in time'
			),
			timeoutMs: INTERRUPT_TURN_RENDERER_TIMEOUT_MS,
		});
		if (!result.success) return result;
		return {
			...result,
			exited: await waitForAiTurnsToExit(processManager, liveBefore, INTERRUPT_TURN_EXIT_WAIT_MS),
		};
	});

	// Set up callback for web server to switch session mode through the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	server.setSwitchModeCallback(
		async (sessionId: string, mode: 'ai' | 'terminal', background?: boolean) => {
			logger.info(
				`[Web→Desktop] Mode switch callback invoked: session=${sessionId}, mode=${mode}`,
				'WebServer'
			);
			const targetWindow = resolveSessionWindow(sessionId);
			if (!targetWindow) {
				logger.warn('No owning window is available for switchMode', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle mode switch and broadcasts
			// This ensures web mode switches go through exact same code path as desktop
			logger.info(`[Web→Desktop] Sending IPC remote:switchMode to renderer`, 'WebServer');
			if (!isWebContentsAvailable(targetWindow)) {
				logger.warn('webContents is not available for switchMode', 'WebServer');
				return false;
			}
			targetWindow.webContents.send('remote:switchMode', sessionId, mode, background === true);
			return true;
		}
	);

	// Set up callback for web server to select/switch to a session in the desktop
	// This forwards to the renderer which handles state updates and broadcasts
	// If tabId is provided, also switches to that tab within the session
	server.setSelectSessionCallback(async (sessionId: string, tabId?: string, focus?: boolean) => {
		logger.info(
			`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}, focus=${focus || false}`,
			'WebServer'
		);
		const targetWindow = resolveSessionWindow(sessionId);
		if (!targetWindow) {
			logger.warn('No owning window is available for selectSession', 'WebServer');
			return false;
		}

		// Forward to renderer - it will handle session selection and broadcasts
		logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
		if (!isWebContentsAvailable(targetWindow)) {
			logger.warn('webContents is not available for selectSession', 'WebServer');
			return false;
		}
		// When focus is requested, bring the verified owning window forward.
		if (focus) {
			targetWindow.show();
			targetWindow.focus();
		}
		targetWindow.webContents.send('remote:selectSession', sessionId, tabId);
		return true;
	});
}
