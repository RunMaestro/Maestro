/** Host-owned identity of the Relay conversation transport, never a plugin option. */
import type { PluginSignatureInfo } from './plugin-registry';

export const RELAY_PLUGIN_ID = 'sh.maestro.relay';
export const RELAY_REPLY_TOOL_ID = `${RELAY_PLUGIN_ID}/send`;

/** Public ed25519 SPKI key of the signed Backstage Relay distribution.
 * Rotation requires a host review; user-added trusted keys cannot change this anchor.
 * This does not grant trust: the live signature must also verify as trusted.
 */
export const RELAY_PUBLISHER_KEY = 'MCowBQYDK2VwAyEAjcVEPI5qSn8vbYo03TWKpLJ6TWwVOLtfg77tuNxPL80=';

/** Match the exact host caller and verified signer before granting conversation transport.
 * Missing verification or a different user-trusted publisher retains the normal risk gate.
 */
export function isRelayConversationIdentity(
	pluginId: string,
	signature: PluginSignatureInfo | undefined
): boolean {
	return (
		pluginId === RELAY_PLUGIN_ID &&
		signature?.status === 'trusted' &&
		signature.signerKey === RELAY_PUBLISHER_KEY
	);
}
