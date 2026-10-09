import { LITE_SETUP_REVISION } from '../../../shared/lite-discovery';
import { randomInt } from 'node:crypto';
import { PairedDevices } from './paired-devices';
import * as opaque from '@serenity-kit/opaque';
import {
	displayName,
	connectionOrigin,
	DISCOVERY_PROTOCOL,
	DISCOVERY_VERSION,
} from '../discovery/types';
import {
	PROTOCOL,
	SCOPE,
	CONNECTION,
	PIN_TTL,
	GRANT_TTL,
	token,
	hash,
	fail,
	requireToken,
	identifiers,
	binding,
	grantBody,
	mac,
	verifies,
	type Challenge,
	type Grant,
	type Descriptor,
	type LocalRequest,
	type Phase,
	type Route,
} from './protocol';
interface Request {
	challenge: Challenge;
	capabilityHash: string;
	state: Phase;
	guesses: number;
	pin?: string;
	record?: string;
	attempt?: { id: string; state: string; expiresAt: number };
	key?: string;
	grant?: Grant;
	counter: number;
}
/** Host role only. Approval methods are never part of the remote transport. RAM-only and bounded. */
export class PairingHost {
	private setup = opaque.server.createSetup();
	private hostKey = opaque.server.getPublicKey(this.setup);
	private epoch = token();
	private requests = new Map<string, Request>();
	private begins: number[] = [];
	private guesses: number[] = [];
	private nonces = new Map<string, number>();
	private endpoints: Set<string>;
	private requestListener?: (id: string) => void;
	onRequest(listener: (id: string) => void): void {
		this.requestListener = listener;
	}
	constructor(
		private name: string,
		private instanceId: string,
		endpoints: string[],
		private now = Date.now,
		readonly persistent = false,
		readonly devices = new PairedDevices(),
		private requestPolicy?: (
			authority: string | undefined,
			remote?: string,
			local?: string
		) => boolean
	) {
		this.name = displayName(name);
		this.endpoints = new Set(endpoints.map(connectionOrigin));
		if ([...this.endpoints].some((origin) => origin.startsWith('http:')) && !requestPolicy)
			fail('direct-tailnet-policy-required');
	}
	static async create(
		name: string,
		instanceId: string,
		endpoints: string[],
		now = Date.now,
		persistent = false,
		devices = new PairedDevices(),
		requestPolicy?: (authority: string | undefined, remote?: string, local?: string) => boolean
	): Promise<PairingHost> {
		await Promise.all([opaque.ready, devices.load()]);
		return new PairingHost(name, instanceId, endpoints, now, persistent, devices, requestPolicy);
	}
	describe(route: Route): Descriptor {
		if (
			!route ||
			!this.endpoints.has(connectionOrigin(route.endpoint)) ||
			!['lan', 'tailscale', 'cloudflare'].includes(route.source) ||
			(route.endpoint.startsWith('http:') && route.source !== 'tailscale')
		)
			fail('route-mismatch');
		return {
			protocol: PROTOCOL,
			hostKey: this.hostKey,
			epoch: this.epoch,
			instanceId: this.instanceId,
			scope: SCOPE,
		};
	}
	/** Public metadata only; no pairing key, epoch, PIN or request capability. */
	discoveryMetadata(endpoint: string, appVersion: string) {
		if (!this.endpoints.has(connectionOrigin(endpoint))) fail('route-mismatch');
		return {
			protocol: DISCOVERY_PROTOCOL,
			version: DISCOVERY_VERSION,
			instanceId: this.instanceId,
			name: this.name,
			appVersion,
			setupRevision: LITE_SETUP_REVISION,
			pairing: { protocol: PROTOCOL, scope: SCOPE, enabled: true },
			capabilities: [SCOPE],
			connection: CONNECTION,
		};
	}
	/** Match configured published authority, never forwarded request aliases. */
	discoveryEndpoint(authority: string | undefined, origin: string | undefined): string {
		const endpoint = [...this.endpoints].find(
			(value) => new URL(value).host.toLowerCase() === authority?.toLowerCase()
		);
		if (!endpoint || (origin !== undefined && origin !== endpoint)) fail('route-mismatch');
		return endpoint;
	}
	private close(r: Request, state: Phase): void {
		r.state = state;
		r.pin = undefined;
		r.record = undefined;
		r.attempt = undefined;
		r.key = undefined;
		r.grant = undefined;
	}
	private sweep(): void {
		const now = this.now();
		this.begins = this.begins.filter((t) => t > now - 60000);
		this.guesses = this.guesses.filter((t) => t > now - 60000);
		for (const [nonce, until] of this.nonces) if (until <= now) this.nonces.delete(nonce);
		for (const [id, r] of this.requests) {
			if ((r.grant?.expiresAt ?? r.challenge.expiresAt) <= now) this.close(r, 'expired');
			if (r.attempt && r.attempt.expiresAt <= now) {
				r.attempt = undefined;
				if (r.guesses >= 5) this.close(r, 'locked');
			}
			if (now > r.challenge.expiresAt + GRANT_TTL) this.requests.delete(id);
		}
	}
	private get(id: string, capability?: string): Request {
		this.sweep();
		const r = this.requests.get(id);
		if (!r) fail('unknown-request');
		if (capability !== undefined) {
			requireToken(capability);
			if (hash(capability) !== r.capabilityHash) fail('invalid-capability');
		}
		return r;
	}
	checkRoute(id: string, capability: string, route: Route): void {
		requireToken(capability);
		const r = this.get(id, capability);
		if (
			r.challenge.endpoint !== route.endpoint ||
			r.challenge.source !== route.source ||
			r.challenge.epoch !== this.epoch
		)
			fail('route-mismatch');
	}
	private expect(r: Request, state: Phase): void {
		if (r.state !== state) fail(r.state);
	}
	begin(
		payload: {
			clientName: string;
			clientNonce: string;
			capabilityHash: string;
			scope: string;
			epoch: string;
		},
		route: Route
	): Challenge {
		const descriptor = this.describe(route);
		this.sweep();
		requireToken(payload.clientNonce);
		if (
			payload.scope !== SCOPE ||
			payload.epoch !== this.epoch ||
			!/^[a-f0-9]{64}$/.test(payload.capabilityHash)
		)
			fail('invalid-request');
		if (this.nonces.has(payload.clientNonce)) fail('replay');
		if (this.begins.length >= 8) fail('request-throttled');
		if (
			[...this.requests.values()].filter(
				(r) => !['cancelled', 'expired', 'locked', 'paired'].includes(r.state)
			).length >= 4
		)
			fail('host-busy');
		const challenge: Challenge = {
			...descriptor,
			endpoint: connectionOrigin(route.endpoint),
			source: route.source,
			requestId: token(),
			clientNonce: payload.clientNonce,
			hostNonce: token(),
			clientName: displayName(payload.clientName),
			expiresAt: this.now() + PIN_TTL,
		};
		this.begins.push(this.now());
		this.nonces.set(payload.clientNonce, this.now() + 600000);
		this.requests.set(challenge.requestId, {
			challenge,
			capabilityHash: payload.capabilityHash,
			state: 'awaiting-host',
			guesses: 0,
			counter: 0,
		});
		this.requestListener?.(challenge.requestId);
		return { ...challenge };
	}
	approvePin(id: string): void {
		const r = this.get(id);
		this.expect(r, 'awaiting-host');
		let pin: string;
		do {
			pin = String(randomInt(1000000)).padStart(6, '0');
		} while ([...this.requests.values()].some((row) => row.pin === pin));
		const start = opaque.client.startRegistration({ password: pin });
		const response = opaque.server.createRegistrationResponse({
			serverSetup: this.setup,
			userIdentifier: id,
			registrationRequest: start.registrationRequest,
		});
		const result = opaque.client.finishRegistration({
			clientRegistrationState: start.clientRegistrationState,
			registrationResponse: response.registrationResponse,
			password: pin,
			identifiers: identifiers(r.challenge),
		});
		this.get(id);
		this.expect(r, 'awaiting-host');
		r.pin = pin;
		r.record = result.registrationRecord;
		r.state = 'pin-issued';
	}
	start(id: string, capability: string, message: string) {
		const r = this.get(id, capability);
		this.expect(r, 'pin-issued');
		if (r.attempt) fail('attempt-in-progress');
		if (r.guesses >= 5) {
			this.close(r, 'locked');
			fail('locked');
		}
		if (this.guesses.length >= 12) fail('attempt-throttled');
		if (typeof message !== 'string' || message.length > 4096) fail('invalid-proof');
		r.guesses++;
		this.guesses.push(this.now());
		try {
			const result = opaque.server.startLogin({
				serverSetup: this.setup,
				userIdentifier: id,
				registrationRecord: r.record,
				startLoginRequest: message,
				identifiers: identifiers(r.challenge),
			});
			r.attempt = { id: token(), state: result.serverLoginState, expiresAt: this.now() + 10000 };
			return { attemptId: r.attempt.id, loginResponse: result.loginResponse };
		} catch {
			if (r.guesses >= 5) this.close(r, 'locked');
			fail('invalid-proof');
		}
	}
	reject(id: string, capability: string, attemptId: string): void {
		const r = this.get(id, capability);
		this.expect(r, 'pin-issued');
		if (r.attempt?.id !== attemptId) fail('replay');
		r.attempt = undefined;
		if (r.guesses >= 5) this.close(r, 'locked');
	}
	finish(id: string, capability: string, attemptId: string, message: string): void {
		const r = this.get(id, capability);
		this.expect(r, 'pin-issued');
		if (r.attempt?.id !== attemptId) fail('replay');
		const attempt = r.attempt;
		r.attempt = undefined;
		try {
			r.key = opaque.server.finishLogin({
				serverLoginState: attempt.state,
				finishLoginRequest: message,
			}).sessionKey;
		} catch {
			if (r.guesses >= 5) this.close(r, 'locked');
			fail('invalid-proof');
		}
		r.pin = undefined;
		r.record = undefined;
		r.state = 'awaiting-confirmation';
	}
	confirm(id: string): void {
		const r = this.get(id);
		this.expect(r, 'awaiting-confirmation');
		r.grant = {
			id: token(),
			requestId: id,
			hostKey: this.hostKey,
			scope: SCOPE,
			expiresAt: this.now() + GRANT_TTL,
			binding: binding(r.challenge),
		};
		r.state = 'approved';
	}
	async claim(id: string, capability: string, proof: string) {
		const r = this.get(id, capability);
		this.expect(r, 'approved');
		if (!r.key || !verifies(r.key, proof, ['claim', binding(r.challenge)])) fail('invalid-proof');
		r.state = 'paired';
		const grant = { ...r.grant! };
		const credential = grant.id + '.' + mac(r.key, ['device', ...grantBody(grant)]);
		try {
			await this.devices.add(
				credential,
				r.challenge.clientName,
				this.instanceId,
				r.challenge.endpoint
			);
			if (r.state !== 'paired') {
				await this.devices.revoke(grant.id);
				fail('cancelled');
			}
		} catch (error) {
			this.close(r, 'cancelled');
			throw error;
		}
		return { grant, proof: mac(r.key!, ['grant', ...grantBody(grant)]) };
	}
	read(
		id: string,
		capability: string,
		grantId: string,
		counter: number,
		method: string,
		proof: string
	) {
		if (method !== SCOPE) fail('forbidden');
		const r = this.get(id, capability);
		this.expect(r, 'paired');
		if (
			!r.grant ||
			!r.key ||
			grantId !== r.grant.id ||
			!Number.isSafeInteger(counter) ||
			counter !== r.counter + 1
		)
			fail('replay');
		if (!verifies(r.key, proof, ['operation', ...grantBody(r.grant), counter, method]))
			fail('invalid-proof');
		r.counter = counter;
		const value = {
			name: this.name,
			instanceId: this.instanceId,
			hostKey: this.hostKey,
			connection: CONNECTION,
		};
		return { value, proof: mac(r.key, ['result', grantId, counter, value]) };
	}
	status(id: string, capability: string) {
		const r = this.get(id, capability);
		return { state: r.state, expiresAt: r.grant?.expiresAt ?? r.challenge.expiresAt };
	}
	async cancel(id: string, capability: string): Promise<void> {
		const r = this.get(id, capability),
			deviceId = r.grant?.id;
		this.close(r, 'cancelled');
		if (deviceId) await this.devices.revoke(deviceId);
	}
	localRequests(): LocalRequest[] {
		this.sweep();
		return [...this.requests.values()].map((r) => ({
			requestId: r.challenge.requestId,
			clientName: r.challenge.clientName,
			endpoint: r.challenge.endpoint,
			state: r.state,
			expiresAt: r.grant?.expiresAt ?? r.challenge.expiresAt,
			pin: r.pin,
		}));
	}
	/** The public locator permits discovery only; control always requires the paired credential. */
	isPublishedRequest(
		authority: string | undefined,
		address?: string,
		localAddress?: string
	): boolean {
		if (this.requestPolicy)
			return this.endpoints.size > 0 && this.requestPolicy(authority, address, localAddress);
		return (
			(!this.persistent || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) &&
			[...this.endpoints].some(
				(origin) => new URL(origin).host.toLowerCase() === authority?.toLowerCase()
			)
		);
	}
	resolveDevice(
		credential: unknown,
		authority: string | undefined,
		address?: string,
		localAddress?: string
	) {
		if (!this.isPublishedRequest(authority, address, localAddress)) return;
		const origin = [...this.endpoints].find(
			(value) => new URL(value).host.toLowerCase() === authority?.toLowerCase()
		)!;
		return this.devices.resolve(credential, this.instanceId, origin);
	}
	authorizeConnection(
		credential: unknown,
		authority: string | undefined,
		address?: string,
		localAddress?: string
	): boolean {
		return !!this.resolveDevice(credential, authority, address, localAddress);
	}
	async revoke(id: string): Promise<void> {
		const r = this.get(id),
			deviceId = r.grant?.id;
		this.close(r, 'cancelled');
		if (deviceId) await this.devices.revoke(deviceId);
	}
	dispose(): void {
		this.requestListener = undefined;
		for (const r of this.requests.values()) this.close(r, 'cancelled');
		this.requests.clear();
		this.endpoints.clear();
		this.setup = '';
		this.epoch = token();
	}
}
