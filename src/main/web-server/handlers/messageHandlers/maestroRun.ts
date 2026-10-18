/**
 * MaestroRun WebSocket handler: `maestro_run_command`, the CLI half of the
 * MaestroRun tile (`maestro-cli maestro-run ...`).
 *
 * One message carrying an `action`, answered by the same MaestroRunService the
 * tile's buttons call over IPC.
 */

import { logger } from '../../../utils/logger';
import { getMaestroRunService } from '../../../maestro-run';
import { LOG_CONTEXT } from './shared';
import type { MaestroRunCommandAction } from '../../../../shared/maestro-run/status';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const ACTIONS: ReadonlySet<MaestroRunCommandAction> = new Set(['status', 'install', 'grant']);

export async function handleMaestroRunCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, { type: 'maestro_run_result', ...payload, requestId: message.requestId });
	};

	const service = getMaestroRunService();
	if (!service) {
		reply({ success: false, error: 'MaestroRun is not available' });
		return;
	}

	const action = (
		typeof message.action === 'string' ? message.action : ''
	) as MaestroRunCommandAction;
	if (!ACTIONS.has(action)) {
		reply({ success: false, error: `Unknown MaestroRun action: ${action || '(none)'}` });
		return;
	}
	logger.info(`[Web] Received maestro_run_command: action=${action}`, LOG_CONTEXT);

	try {
		if (action === 'status') {
			// A status asked for by hand should be the truth now, not the cache.
			const status = await service.refresh({ checkLatest: message.checkLatest === true });
			reply({ success: true, status });
			return;
		}
		// Installing and granting act for the user who turned the feature on.
		if (!service.status().enabled) {
			reply({
				success: false,
				error: 'MaestroRun is turned off. Run `maestro-cli encore enable maestroRun` first.',
				status: service.status(),
			});
			return;
		}
		const status =
			action === 'install'
				? await service.install()
				: await service.requestAccess({ reveal: message.reveal === true });
		reply({ success: true, status });
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		reply({ success: false, error: detail, status: service.status() });
	}
}
