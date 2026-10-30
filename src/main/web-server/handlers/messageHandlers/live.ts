/**
 * Live mode WebSocket handler: `live_command`, the CLI half of the Left Bar
 * LIVE pill and its Remote Control row (`maestro-cli live status|on|off` and
 * `maestro-cli live tunnel on|off`).
 *
 * Routes to the ONE LiveModeController the pill's `live:set` IPC calls, so the
 * CLI reaches the same switch. Explicit `on` / `off` only, both idempotent.
 *
 * CLI ONLY: the socket must have presented this boot's CLI secret
 * (`client.cli`). The same server answers LAN and tunnel browsers, and none
 * of them may start or stop the host's server (the `live:*` switches are off
 * the bridge allowlist for the same reason).
 *
 * A switch replaces the server this socket is on, so the reply goes FIRST and
 * the switch starts once it is on the wire. The reply names the revision the
 * switch will finish at; the CLI reconnects through `cli-server.json` and
 * polls `status` until it gets there. Remote Control does not touch the
 * server, so `remote-on` / `remote-off` answer after the switch has finished.
 */

import { logger } from '../../../utils/logger';
import { getLiveModeController } from '../../live-mode';
import {
	LIVE_COMMAND_RESULT,
	isLiveCommandAction,
	type LiveCommandResult,
} from '../../../../shared/liveMode';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

export function handleLiveCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const reply = (payload: LiveCommandResult, onSent?: () => void) => {
		ctx.send(
			client,
			{ type: LIVE_COMMAND_RESULT, ...payload, requestId: message.requestId },
			onSent
		);
	};

	if (!client.cli) {
		logger.warn(`[Web] Refused live_command from non-CLI client ${client.id}`, LOG_CONTEXT);
		reply({ success: false, error: 'Live mode cannot be switched over the web interface' });
		return;
	}

	const action = (message as Record<string, unknown>).action;
	if (!isLiveCommandAction(action)) {
		reply({ success: false, error: `Unknown live action: ${String(action)}` });
		return;
	}

	const controller = getLiveModeController();
	if (!controller) {
		reply({ success: false, error: 'Live mode is not available yet. Try again in a moment.' });
		return;
	}

	const status = controller.getStatus();
	if (action === 'status') {
		reply({ success: true, status });
		return;
	}

	if (action === 'remote-on' || action === 'remote-off') {
		const switching =
			action === 'remote-on' ? controller.startRemoteControl() : controller.stopRemoteControl();
		switching.then(
			(result) =>
				reply({
					success: result.success,
					changed: true,
					status: result.status,
					...(result.error ? { error: result.error } : {}),
				}),
			(error: unknown) =>
				reply({ success: false, error: error instanceof Error ? error.message : String(error) })
		);
		return;
	}

	const target = action === 'on';
	if (status.live === target) {
		reply({ success: true, changed: false, status });
		return;
	}

	logger.info(`[Web] live_command: turning Live ${action}`, LOG_CONTEXT);
	reply({ success: true, changed: true, awaitRevision: status.revision + 1, status }, () => {
		setImmediate(() => {
			controller.set(target).catch((error: unknown) => {
				logger.error(
					`[Web] live_command ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
					LOG_CONTEXT
				);
			});
		});
	});
}
