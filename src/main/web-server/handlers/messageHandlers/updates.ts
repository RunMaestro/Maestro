/**
 * Updates WebSocket message handlers: `maestro-cli rollback`.
 *
 * Handles `list_rollback_targets` (the Roll Back list) and `rollback_update`
 * (its Roll Back button). Both call the same main-process functions the Check
 * for Updates modal's IPC channels call, so the CLI and the modal cannot drift,
 * and a CLI download shows its progress in any open modal.
 *
 * CLI sockets only. A rollback replaces the installed app with an older build,
 * which may carry vulnerabilities a later release fixed; a LAN or tunnel
 * browser must never be able to do that to the host. The IPC side is closed to
 * browsers by `BRIDGE_DENIED_CHANNELS`.
 */

import { app } from 'electron';
import { logger } from '../../../utils/logger';
import { listRollbackTargets } from '../../../update-checker';
import { downloadRollback } from '../../../auto-updater';
import { getSettingsStore } from '../../../stores/getters';
import { LOG_CONTEXT } from './shared';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** Refuse a non-CLI socket. Returns true when the request was refused. */
function refuseNonCli(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	type: string
): boolean {
	if (client.cli) return false;
	logger.warn(`Refused ${message.type} from non-CLI client ${client.id}`, LOG_CONTEXT);
	ctx.send(client, {
		type,
		success: false,
		error: 'Rolling back Maestro is not available over the web interface',
		requestId: message.requestId,
	});
	return true;
}

/** `--prerelease` when given, otherwise the user's "Include pre-release updates" setting. */
function resolveIncludePrerelease(message: WebClientMessage): boolean {
	if (typeof message.includePrerelease === 'boolean') return message.includePrerelease;
	return getSettingsStore().get('enableBetaUpdates') === true;
}

export async function handleListRollbackTargets(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = 'list_rollback_targets_result';
	if (refuseNonCli(ctx, client, message, type)) return;
	const result = await listRollbackTargets(app.getVersion(), resolveIncludePrerelease(message));
	ctx.send(client, {
		type,
		success: !result.error,
		...result,
		requestId: message.requestId,
	});
}

export async function handleRollbackUpdate(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const type = 'rollback_update_result';
	if (refuseNonCli(ctx, client, message, type)) return;
	const version = typeof message.version === 'string' ? message.version : '';
	logger.info(`[Web] Received rollback_update: version=${version || '(none)'}`, LOG_CONTEXT);
	const result = await downloadRollback(version);
	ctx.send(client, {
		type,
		...result,
		currentVersion: app.getVersion(),
		requestId: message.requestId,
	});
}
