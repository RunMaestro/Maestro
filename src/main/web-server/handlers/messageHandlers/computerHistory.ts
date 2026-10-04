/**
 * Computer History WebSocket handler: `computer_history_command`, the CLI half
 * of the Computer History UI (`maestro-cli computer-history ...` writes).
 *
 * One message carrying an `action` (same shape as `snooze_command`), routed
 * to the ONE ComputerHistoryService the desktop UI's IPC calls.
 *
 * CLI ONLY: the socket must have presented this boot's CLI secret
 * (`client.cli`). The WS server also serves signed-in browsers (web-desktop,
 * possibly remote through the tunnel); none of them may pause, clear, or
 * re-rule the user's screen history, which is also why every
 * `computerHistory:*` IPC channel is on the bridge deny list (D15). Reads are
 * not served here at all: the CLI reads the store from disk.
 */

import { logger } from '../../../utils/logger';
import { getComputerHistoryService } from '../../../computer-history';
import { LOG_CONTEXT } from './shared';
import type { ComputerHistoryCommandAction } from '../../../../shared/computer-history/status';
import type { ComputerHistoryConfigPatch } from '../../../../shared/computer-history/config';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

const ACTIONS: ReadonlySet<ComputerHistoryCommandAction> = new Set([
	'status',
	'pause',
	'resume',
	'rules-add',
	'rules-remove',
	'clear',
	'enable-accessibility',
	'config-set',
]);

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export async function handleComputerHistoryCommand(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const reply = (payload: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'computer_history_command_result',
			...payload,
			requestId: message.requestId,
		});
	};

	if (!client.cli) {
		logger.warn(
			`[Web] Refused computer_history_command from non-CLI client ${client.id}`,
			LOG_CONTEXT
		);
		reply({ success: false, error: 'Computer History is not available over the web interface' });
		return;
	}

	const m = message as Record<string, unknown>;
	const action = m.action as ComputerHistoryCommandAction;
	if (typeof action !== 'string' || !ACTIONS.has(action)) {
		reply({ success: false, error: `Unknown computer-history action: ${String(m.action)}` });
		return;
	}

	const service = getComputerHistoryService();
	if (!service) {
		reply({ success: false, error: 'Computer History is not available in this session' });
		return;
	}

	logger.info(`[Web] computer_history_command: ${action}`, LOG_CONTEXT);

	try {
		switch (action) {
			case 'status':
				reply({ success: true, status: service.status(), digests: service.digestStatus() });
				return;
			case 'pause':
				reply({ success: true, status: await service.pause(num(m.forMs) ?? null) });
				return;
			case 'resume':
				reply({ success: true, status: await service.resume() });
				return;
			case 'rules-add': {
				const match = m.match;
				if (match !== 'app' && match !== 'domain') {
					reply({ success: false, error: 'A rule needs --app or --domain' });
					return;
				}
				const added = await service.addRule(
					match,
					typeof m.value === 'string' ? m.value : '',
					m.ruleAction === 'record' ? 'record' : 'ignore'
				);
				reply({ success: true, rule: added.rule, matches: added.matches });
				return;
			}
			case 'rules-remove': {
				const ruleAction =
					m.ruleAction === 'record' || m.ruleAction === 'ignore' ? m.ruleAction : undefined;
				const removed = await service.removeRule(typeof m.id === 'string' ? m.id : '', ruleAction);
				if (!removed) {
					reply({ success: false, error: `No rule matches "${String(m.id)}"` });
					return;
				}
				reply({ success: true, rule: removed });
				return;
			}
			case 'clear': {
				const all = m.all === true;
				const sinceMs = num(m.sinceMs);
				if (!all && sinceMs === undefined) {
					reply({ success: false, error: 'Specify --since or --all' });
					return;
				}
				reply({ success: true, ...(await service.clear(all ? { all } : { sinceMs })) });
				return;
			}
			case 'enable-accessibility':
				reply({ success: true, result: await service.requestAccessibility() });
				return;
			case 'config-set': {
				const patch = (
					m.patch && typeof m.patch === 'object' ? m.patch : {}
				) as ComputerHistoryConfigPatch;
				reply({ success: true, config: await service.setConfig(patch) });
				return;
			}
		}
	} catch (error) {
		reply({ success: false, error: error instanceof Error ? error.message : String(error) });
	}
}
