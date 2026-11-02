/** JSON-only plugin primitives. No protocol, account or provider semantics. */
export type PluginJson =
	| null
	| boolean
	| number
	| string
	| PluginJson[]
	| { [key: string]: PluginJson };

export const PLUGIN_PRIMITIVE_ERRORS = {
	PLUGIN_DENIED: 'Plugin access denied.',
	PLUGIN_INVALID: 'Invalid plugin request.',
	PLUGIN_LIMIT: 'Plugin request exceeds a limit.',
	PLUGIN_TIMEOUT: 'Plugin request timed out.',
	PLUGIN_CANCELED: 'Plugin request canceled.',
	PLUGIN_UNAVAILABLE: 'Plugin service unavailable.',
	PLUGIN_CONFLICT: 'Plugin record revision changed.',
	PLUGIN_INTEGRITY: 'Plugin record integrity check failed.',
} as const;
export type PluginPrimitiveErrorCode = keyof typeof PLUGIN_PRIMITIVE_ERRORS;

export interface PluginEndpoint {
	host: string;
	port: number;
}
export type PluginTlsPart = { base64: string } | { secretRef: string; encoding: 'quoted-ascii' };
export interface PluginRecordValue {
	revision: number;
	value: PluginJson;
}
export interface PluginConsumer {
	consumerId: string;
	callerAgentId: string;
	config: PluginJson;
}
/** Explicit on-disk format; unlike v1, receipt identity survives same-signer updates. */
export const PLUGIN_RECEIPT_KEY_PREFIX = 'receipt-v2:';

export interface PluginReceipt {
	receiptId: string;
	status: 'accepted' | 'duplicate';
}

/** Exact DNS endpoint; no numeric/hex final label, IPs, URLs, wildcards or localhost. */
export function pluginEndpointScope(host: unknown, port: unknown): string | undefined {
	return endpointScope(host, port, false);
}

function endpointScope(
	host: unknown,
	port: unknown,
	historicalReference: boolean
): string | undefined {
	if (
		typeof host !== 'string' ||
		host.length > 253 ||
		!host.includes('.') ||
		!host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
		/^[0-9.]+$/.test(host) ||
		(!historicalReference &&
			/^(?:[0-9]+|0x[0-9a-f]*)$/.test(host.slice(host.lastIndexOf('.') + 1))) ||
		host.endsWith('.localhost') ||
		!Number.isInteger(port) ||
		(port as number) < 1 ||
		(port as number) > 65535
	)
		return undefined;
	return `${host}:${port}`;
}

export function isPluginEndpointScope(scope: unknown): scope is string {
	if (typeof scope !== 'string') return false;
	const [host, port, extra] = scope.split(':');
	return extra === undefined && pluginEndpointScope(host, Number(port)) === scope;
}

/** Schema-only historical cleanup provenance; never use this to authorize an endpoint. */
export function isStoredPluginEndpointScope(scope: unknown): scope is string {
	if (typeof scope !== 'string') return false;
	const [host, port, extra] = scope.split(':');
	return extra === undefined && endpointScope(host, Number(port), true) === scope;
}

export const PLUGIN_RECORD_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
export const PLUGIN_TOPIC_PATTERN = /^[a-z][a-z0-9._-]{0,95}$/;

/** Manifest sentinel grants no endpoint; sets are bounded and canonical. */
export function parsePluginEndpointScopes(scope: unknown): readonly string[] | null {
	if (scope === 'none') return [];
	if (typeof scope !== 'string' || scope.length > 4200) return null;
	const members = scope.split(',');
	if (
		!members.length ||
		members.length > 16 ||
		new Set(members).size !== members.length ||
		!members.every(isPluginEndpointScope)
	)
		return null;
	return members;
}
