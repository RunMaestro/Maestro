/** Execute the six declared reads in main, over existing brokered native primitives.
 * No plugin code, protocol command, endpoint or secret may be supplied by the model.
 */
import { RELAY_PLUGIN_ID } from '../../../shared/plugins/relay-identity';
import { PluginAuthorityError } from '../plugin-authority';
import type { PermissionBroker } from '../permission-broker';
import type { PluginPrimitives } from '../plugin-primitives';
import { createMailService } from './mail-service';
import type { MailPlatform } from './mail-platform';

export function createRelayMailReader(primitives: PluginPrimitives, broker: PermissionBroker) {
	const call = async <T>(
		method: Parameters<PluginPrimitives['call']>[1],
		params: unknown
	): Promise<T> => {
		const check = () => {
			if (!broker.authorize(RELAY_PLUGIN_ID, method, params).allowed)
				throw new PluginAuthorityError('PLUGIN_DENIED');
		};
		check();
		const result = await primitives.call(RELAY_PLUGIN_ID, method, params);
		// Cleanup confers no authority and remains possible after revoke.
		if (method !== 'net.tlsClose') check();
		return result as T;
	};
	const platform: MailPlatform = {
		invocations: { inspect: (invocationId) => call('invocations.inspect', { invocationId }) },
		records: { read: (key) => call('records.read', { key }) },
		net: {
			tlsOpen: (input) => call('net.tlsOpen', input),
			tlsRead: (input) => call('net.tlsRead', input),
			tlsWrite: (input) => call('net.tlsWrite', input),
			tlsClose: (input) => call('net.tlsClose', input),
		},
	};
	return createMailService(platform, () => true);
}

export type RelayMailReader = ReturnType<typeof createRelayMailReader>;
