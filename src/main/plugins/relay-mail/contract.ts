/** Host-owned effects, never inferred from tool prose or a plugin readOnly hint. */
import type { AgentToolContribution } from '../../../shared/plugins/contributions';
import { RELAY_PLUGIN_ID } from '../../../shared/plugins/relay-identity';
import type { MailOperation } from './mail-service';

const operations: Readonly<Record<string, MailOperation>> = Object.freeze({
	'mail-list-accounts': 'listAccounts',
	'mail-search-headers': 'searchHeaders',
	'mail-read-headers': 'readHeaders',
	'mail-read-body': 'readBody',
	'mail-list-attachments': 'listAttachments',
	'mail-read-attachment': 'readAttachment',
});

export function relayMailReadOperation(tool: AgentToolContribution): MailOperation | undefined {
	if (tool.pluginId !== RELAY_PLUGIN_ID || tool.id !== `${RELAY_PLUGIN_ID}/${tool.localId}`)
		return undefined;
	return Object.prototype.hasOwnProperty.call(operations, tool.localId)
		? operations[tool.localId]
		: undefined;
}
