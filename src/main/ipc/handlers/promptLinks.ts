/**
 * Prompt Links IPC (`promptLinks:*`).
 *
 * DESKTOP-ONLY by construction: the web-desktop bridge refuses every
 * `promptLinks:*` channel (`BRIDGE_DENIED_CHANNELS`). A browser on the LAN or
 * the tunnel can already send a prompt while it is connected; minting a link
 * would let it keep that power after it disconnects, or after its Web Login
 * account is disabled. `maestro-cli prompt-link` reaches the same service
 * through the CLI-only `prompt_link_command` WebSocket message.
 *
 * Every verb is a thin pass-through to the service in `src/main/prompt-links/`,
 * which validates and throws with a user-facing sentence.
 */

import { ipcMain } from 'electron';
import { withIpcErrorLogging } from '../../utils/ipcHandler';
import {
	createPromptLink,
	listPromptLinks,
	markPromptLinksRendererReady,
	revokePromptLink,
} from '../../prompt-links';
import type {
	PromptLinkCreateInput,
	PromptLinkCreated,
	PromptLinkPublic,
} from '../../../shared/promptLinks';

const LOG_CONTEXT = '[PromptLinks]';

function handlerOpts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

/** Register the `promptLinks:*` channels. */
export function registerPromptLinkHandlers(): void {
	ipcMain.handle(
		'promptLinks:list',
		withIpcErrorLogging(handlerOpts('list'), async (): Promise<PromptLinkPublic[]> => {
			return listPromptLinks();
		})
	);

	ipcMain.handle(
		'promptLinks:create',
		withIpcErrorLogging(
			handlerOpts('create'),
			async (input: PromptLinkCreateInput): Promise<PromptLinkCreated> => {
				return createPromptLink(input);
			}
		)
	);

	ipcMain.handle(
		'promptLinks:revoke',
		withIpcErrorLogging(handlerOpts('revoke'), async (id: string): Promise<PromptLinkPublic> => {
			return revokePromptLink(id);
		})
	);

	// The renderer has restored its agents: a link clicked while Maestro was
	// closed may now open its tab.
	ipcMain.handle(
		'promptLinks:rendererReady',
		withIpcErrorLogging(handlerOpts('rendererReady'), async (): Promise<void> => {
			markPromptLinksRendererReady();
		})
	);
}
