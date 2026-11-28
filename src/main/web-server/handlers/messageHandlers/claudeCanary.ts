/**
 * Claude TUI canary WebSocket message handlers, for `maestro-cli claude-canary`.
 *
 * `claude_canary_status` reads the last result; `claude_canary_run` runs the
 * canary now, as the app's own hourly check would after an update. Both call
 * the app's one canary (src/main/agents/claude-tui-canary.ts).
 */

import { getClaudeTuiCanary } from '../../../agents/claude-tui-canary';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** Handle claude_canary_status - the last canary result, if any. */
export function handleClaudeCanaryStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const canary = getClaudeTuiCanary();
	ctx.send(client, {
		type: 'claude_canary_status_result',
		success: canary !== null,
		...(canary ? { last: canary.getLastResult() ?? null } : { error: 'The canary is not running' }),
		requestId: message.requestId,
	});
}

/** Handle claude_canary_run - run the canary now, whatever the version. */
export async function handleClaudeCanaryRun(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const canary = getClaudeTuiCanary();
	if (!canary) {
		ctx.send(client, {
			type: 'claude_canary_run_result',
			success: false,
			error: 'The canary is not running',
			requestId: message.requestId,
		});
		return;
	}
	const outcome = await canary.check({ force: true });
	ctx.send(client, {
		type: 'claude_canary_run_result',
		success: true,
		outcome,
		requestId: message.requestId,
	});
}
