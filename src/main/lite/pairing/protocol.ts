import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DiscoverySource } from '../discovery/types';
export const PROTOCOL = 'maestro-device-pairing/1';
/** Explicit host approval grants full operator access to a revocable paired device. */
export const SCOPE = 'host.control';
export const PIN_TTL = 120000;
export const GRANT_TTL = 8 * 60 * 60 * 1000;
export const CONNECT_PATH = '/.well-known/maestro/connect';
export const ADMISSION_HEADER = 'x-maestro-device-credential';
export const CONNECTION_CAPABILITIES = ['sessions', 'terminal', 'files', 'browserRelay'] as const;
export interface ConnectionDescriptor {
	path: typeof CONNECT_PATH;
	authentication: 'device-pairing';
	admission: 'device';
	capabilities: readonly string[];
}
export const CONNECTION: ConnectionDescriptor = {
	path: CONNECT_PATH,
	authentication: 'device-pairing',
	admission: 'device',
	capabilities: CONNECTION_CAPABILITIES,
};
export const PAIR_PATH = '/.well-known/maestro/pairing';
export const token = () => randomBytes(32).toString('base64url');
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function fail(code: string): never {
	throw new Error(code);
}
export function requireToken(value: unknown): asserts value is string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) fail('invalid-capability');
}
export interface Route {
	endpoint: string;
	source: DiscoverySource;
	peerId?: string;
}
export interface Descriptor {
	protocol: typeof PROTOCOL;
	hostKey: string;
	epoch: string;
	instanceId: string;
	scope: typeof SCOPE;
}
export interface Challenge extends Descriptor, Route {
	requestId: string;
	clientNonce: string;
	hostNonce: string;
	clientName: string;
	expiresAt: number;
}
export interface Grant {
	id: string;
	requestId: string;
	hostKey: string;
	scope: typeof SCOPE;
	expiresAt: number;
	binding: string;
}
export interface Metadata {
	name: string;
	instanceId: string;
	hostKey: string;
	connection: ConnectionDescriptor;
}
export type Phase =
	| 'awaiting-host'
	| 'pin-issued'
	| 'awaiting-confirmation'
	| 'approved'
	| 'paired'
	| 'cancelled'
	| 'expired'
	| 'locked';
export interface RemoteStatus {
	state: Phase;
	expiresAt: number;
}
export interface LocalRequest extends RemoteStatus {
	requestId: string;
	clientName: string;
	endpoint: string;
	pin?: string;
}
export function identifiers(c: Challenge) {
	return {
		client: JSON.stringify([PROTOCOL, c.requestId, c.clientNonce, c.clientName]),
		server: JSON.stringify([
			PROTOCOL,
			c.hostNonce,
			c.hostKey,
			c.instanceId,
			c.epoch,
			c.endpoint,
			c.source,
			c.expiresAt,
			c.scope,
		]),
	};
}
export const binding = (c: Challenge) => JSON.stringify(identifiers(c));
export const grantBody = (g: Grant) => [
	g.id,
	g.requestId,
	g.hostKey,
	g.scope,
	g.expiresAt,
	g.binding,
];
export function mac(key: string, body: unknown[]): string {
	return createHmac('sha256', Buffer.from(key, 'base64'))
		.update(JSON.stringify(body))
		.digest('base64url');
}
export function verifies(key: string, proof: unknown, body: unknown[]): boolean {
	if (typeof proof !== 'string' || proof.length !== 43) return false;
	const expected = mac(key, body);
	return timingSafeEqual(Buffer.from(expected), Buffer.from(proof));
}
export interface PairingTransport {
	call<T>(operation: string, payload: unknown, signal?: AbortSignal): Promise<T>;
}
