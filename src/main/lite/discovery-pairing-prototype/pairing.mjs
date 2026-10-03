/* global TextEncoder, btoa, atob, crypto, structuredClone */
// PROTOTYPE: real OPAQUE, in-memory state; no HTTP routes, sockets or production grants.
import * as opaque from '@serenity-kit/opaque';
import { origin, label } from './discovery.mjs';
export const PROTOCOL = 'maestro-pair-prototype/1';
export const SCOPE = 'host.metadata';
export const PIN_TTL = 120000;
export const GRANT_TTL = 300000;
const CLOSED = new Set(['expired', 'cancelled', 'locked', 'network-changed']);
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const decode = (value) =>
	Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
const hex = (bytes) =>
	[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
async function hash(value) {
	return hex(await crypto.subtle.digest('SHA-256', encode(value)));
}
function fail(code) {
	throw Object.assign(new Error(code), { code });
}
function validToken(value) {
	return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
}
function pinNumber() {
	let value;
	do {
		value = crypto.getRandomValues(new Uint32Array(1))[0];
	} while (value >= 4294000000);
	return String(value % 1000000).padStart(6, '0');
}
export function identifiers(challenge) {
	return {
		client: JSON.stringify([
			PROTOCOL,
			challenge.requestId,
			challenge.clientNonce,
			challenge.clientName,
		]),
		server: JSON.stringify([
			PROTOCOL,
			challenge.hostKey,
			challenge.hostNonce,
			challenge.endpoint,
			challenge.transport,
			challenge.epoch,
			challenge.expiresAt,
			challenge.scope,
		]),
	};
}
const binding = (challenge) => JSON.stringify(identifiers(challenge));
async function sessionKey(value) {
	return crypto.subtle.importKey('raw', decode(value), { name: 'HMAC', hash: 'SHA-256' }, false, [
		'sign',
		'verify',
	]);
}
async function mac(key, data) {
	return btoa(
		String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, encode(data))))
	);
}
async function verifies(key, signature, data) {
	if (typeof signature !== 'string' || signature.length > 128) return false;
	try {
		return await crypto.subtle.verify('HMAC', key, decode(signature), encode(data));
	} catch {
		return false;
	}
}
const grantBody = (grant) => [
	grant.id,
	grant.requestId,
	grant.hostKey,
	grant.scope,
	grant.expiresAt,
	grant.binding,
];

export class PairingHost {
	#setup;
	#key;
	#name;
	#endpoints;
	#now;
	#epoch = 1;
	#requests = new Map();
	#newRequests = [];
	#attempts = [];
	#nonces = new Map();
	constructor(name, endpoints, now) {
		this.#setup = opaque.server.createSetup();
		this.#key = opaque.server.getPublicKey(this.#setup);
		this.#name = label(name);
		this.#endpoints = new Set(endpoints.map(origin));
		this.#now = now;
	}
	static async create({ name, endpoints, now = Date.now }) {
		await opaque.ready;
		return new PairingHost(name, endpoints, now);
	}
	describe(route) {
		if (
			!this.#endpoints.has(origin(route.endpoint)) ||
			!['lan', 'tailscale', 'cloudflare'].includes(route.source)
		)
			fail('route-mismatch');
		return { protocol: PROTOCOL, hostKey: this.#key, epoch: this.#epoch };
	}
	#close(request, state) {
		request.state = state;
		request.pin = undefined;
		request.record = undefined;
		request.attempt = undefined;
		request.key = undefined;
		request.grant = undefined;
	}
	#sweep() {
		const now = this.#now();
		for (const request of this.#requests.values()) {
			const expires = request.grant?.expiresAt ?? request.challenge.expiresAt;
			if (!CLOSED.has(request.state) && expires <= now) this.#close(request, 'expired');
			if (request.attempt && request.attempt.expiresAt <= now) {
				request.attempt = undefined;
				if (request.guesses >= 5) this.#close(request, 'locked');
			}
		}
		this.#newRequests = this.#newRequests.filter((time) => time > now - 60000);
		this.#attempts = this.#attempts.filter((time) => time > now - 60000);
		for (const [nonce, expiry] of this.#nonces) if (expiry <= now) this.#nonces.delete(nonce);
		while (this.#requests.size > 64) {
			const old = [...this.#requests].find(([, value]) => CLOSED.has(value.state));
			if (!old) break;
			this.#requests.delete(old[0]);
		}
	}
	#get(id) {
		this.#sweep();
		const request = this.#requests.get(id);
		if (!request) fail('unknown-request');
		return request;
	}
	#require(request, state) {
		if (request.state !== state) fail(CLOSED.has(request.state) ? request.state : 'invalid-state');
	}
	begin(payload, route) {
		this.#sweep();
		const descriptor = this.describe(route);
		if (
			payload.scope !== SCOPE ||
			!validToken(payload.clientNonce) ||
			!/^[a-f0-9]{64}$/.test(payload.cancelHash)
		)
			fail('invalid-request');
		if (route.epoch !== descriptor.epoch) fail('network-changed');
		if (this.#nonces.has(payload.clientNonce)) fail('replay');
		if (this.#newRequests.length >= 8) fail('request-throttled');
		if (
			[...this.#requests.values()].filter((row) => !CLOSED.has(row.state) && row.state !== 'paired')
				.length >= 4
		)
			fail('host-busy');
		const now = this.#now();
		const challenge = {
			requestId: crypto.randomUUID(),
			clientNonce: payload.clientNonce,
			clientName: label(payload.clientName),
			hostNonce: token(),
			hostKey: this.#key,
			endpoint: origin(route.endpoint),
			transport: route.source,
			epoch: this.#epoch,
			expiresAt: now + PIN_TTL,
			scope: SCOPE,
		};
		this.#newRequests.push(now);
		this.#nonces.set(payload.clientNonce, now + 600000);
		this.#requests.set(challenge.requestId, {
			challenge,
			cancelHash: payload.cancelHash,
			state: 'awaiting-host',
			guesses: 0,
		});
		return structuredClone(challenge);
	}
	// HOST-LOCAL ONLY. Never expose through an unauthenticated/remote route.
	approvePin(id) {
		const request = this.#get(id);
		this.#require(request, 'awaiting-host');
		let pin;
		do {
			pin = pinNumber();
		} while ([...this.#requests.values()].some((row) => row.pin === pin));
		const registration = opaque.client.startRegistration({ password: pin });
		const response = opaque.server.createRegistrationResponse({
			serverSetup: this.#setup,
			userIdentifier: id,
			registrationRequest: registration.registrationRequest,
		});
		const result = opaque.client.finishRegistration({
			clientRegistrationState: registration.clientRegistrationState,
			registrationResponse: response.registrationResponse,
			password: pin,
			identifiers: identifiers(request.challenge),
		});
		// Registration is synchronous, but expiry is checked again after Argon2 work.
		if (request.challenge.expiresAt <= this.#now()) {
			this.#close(request, 'expired');
			fail('expired');
		}
		request.pin = pin;
		request.record = result.registrationRecord;
		request.state = 'pin-issued';
	}
	start(id, message) {
		const request = this.#get(id);
		this.#require(request, 'pin-issued');
		if (request.attempt) fail('attempt-in-progress');
		if (request.guesses >= 5) {
			this.#close(request, 'locked');
			fail('locked');
		}
		if (this.#attempts.length >= 12) fail('attempt-throttled');
		if (typeof message !== 'string' || message.length > 4096) fail('invalid-proof');
		request.guesses++;
		this.#attempts.push(this.#now());
		let result;
		try {
			result = opaque.server.startLogin({
				serverSetup: this.#setup,
				userIdentifier: id,
				registrationRecord: request.record,
				startLoginRequest: message,
				identifiers: identifiers(request.challenge),
			});
		} catch {
			if (request.guesses >= 5) this.#close(request, 'locked');
			fail('invalid-proof');
		}
		request.attempt = {
			id: token(),
			state: result.serverLoginState,
			expiresAt: Math.min(this.#now() + 10000, request.challenge.expiresAt),
		};
		return { attemptId: request.attempt.id, loginResponse: result.loginResponse };
	}
	rejectAttempt(id, attemptId) {
		const request = this.#get(id);
		this.#require(request, 'pin-issued');
		if (request.attempt?.id !== attemptId) fail('replay');
		request.attempt = undefined;
		if (request.guesses >= 5) this.#close(request, 'locked');
	}
	async finish(id, attemptId, message) {
		const request = this.#get(id);
		this.#require(request, 'pin-issued');
		if (request.attempt?.id !== attemptId) fail('replay');
		const attempt = request.attempt;
		request.attempt = undefined; // Consume before any asynchronous work.
		let result;
		try {
			result = opaque.server.finishLogin({
				serverLoginState: attempt.state,
				finishLoginRequest: message,
			});
		} catch {
			if (request.guesses >= 5) this.#close(request, 'locked');
			fail('invalid-proof');
		}
		request.state = 'verifying';
		const key = await sessionKey(result.sessionKey);
		this.#get(id);
		this.#require(request, 'verifying');
		request.key = key;
		request.pin = undefined;
		request.record = undefined;
		request.state = 'awaiting-confirmation';
		return { state: request.state };
	}
	// HOST-LOCAL ONLY. PIN possession does not itself authorize a grant.
	confirm(id) {
		const request = this.#get(id);
		this.#require(request, 'awaiting-confirmation');
		request.grant = {
			id: crypto.randomUUID(),
			requestId: id,
			hostKey: this.#key,
			scope: SCOPE,
			expiresAt: this.#now() + GRANT_TTL,
			binding: binding(request.challenge),
		};
		request.counter = 0;
		request.state = 'approved';
	}
	async claim(id, proof) {
		const request = this.#get(id);
		this.#require(request, 'approved');
		if (!(await verifies(request.key, proof, ['claim', binding(request.challenge)])))
			fail('invalid-proof');
		this.#get(id);
		this.#require(request, 'approved');
		request.state = 'paired';
		const grant = structuredClone(request.grant);
		return { grant, proof: await mac(request.key, ['grant', ...grantBody(grant)]) };
	}
	async read(grantId, counter, method, proof) {
		if (method !== SCOPE) fail('forbidden');
		this.#sweep();
		const request = [...this.#requests.values()].find((row) => row.grant?.id === grantId);
		if (!request) fail('expired-or-revoked');
		this.#require(request, 'paired');
		if (!Number.isSafeInteger(counter) || counter !== request.counter + 1) fail('replay');
		if (
			!(await verifies(request.key, proof, [
				'operation',
				...grantBody(request.grant),
				counter,
				method,
			]))
		)
			fail('invalid-proof');
		this.#get(request.challenge.requestId);
		this.#require(request, 'paired');
		if (counter !== request.counter + 1) fail('replay');
		request.counter = counter;
		const value = { name: this.#name, hostKey: this.#key };
		return {
			value,
			proof: await mac(request.key, ['result', grantId, counter, value.name, value.hostKey]),
		};
	}
	async cancel(id, secret) {
		if (!validToken(secret)) fail('invalid-cancellation');
		const request = this.#get(id);
		if ((await hash(secret)) !== request.cancelHash) fail('invalid-cancellation');
		this.#close(request, 'cancelled');
	}
	cancelLocally(id) {
		this.#close(this.#get(id), 'cancelled');
	}
	networkChanged() {
		this.#epoch++;
		for (const request of this.#requests.values()) this.#close(request, 'network-changed');
	}
	status(id) {
		const request = this.#get(id);
		return {
			requestId: id,
			clientName: request.challenge.clientName,
			state: request.state,
			guessesRemaining: Math.max(0, 5 - request.guesses),
			expiresAt: request.grant?.expiresAt ?? request.challenge.expiresAt,
			scope: SCOPE,
			endpoint: request.challenge.endpoint,
		};
	}
	// This is the separate privileged HOST screen, never the Lite/public projection.
	hostScreen() {
		this.#sweep();
		return [...this.#requests.values()].map((row) => ({
			...this.status(row.challenge.requestId),
			pin: row.pin ?? null,
		}));
	}
}

export class PairingClient {
	#now;
	#name;
	#cancel;
	#challenge;
	#key;
	#grant;
	#counter = 0;
	#busy = false;
	#phase = 'idle';
	#error = null;
	#revision = 0;
	constructor({ name = 'Demo Lite laptop', now = Date.now } = {}) {
		this.#name = label(name);
		this.#now = now;
	}
	async begin(host, route, trustedHostKey) {
		if (this.#busy) fail('attempt-in-progress');
		if (
			this.#challenge &&
			!['cancelled', 'expired', 'network-changed', 'locked', 'idle'].includes(this.#phase)
		)
			fail('cancel-before-retry');
		const revision = ++this.#revision;
		this.#busy = true;
		this.#challenge = undefined;
		this.#cancel = undefined;
		this.#key = undefined;
		this.#grant = undefined;
		this.#counter = 0;
		this.#error = null;
		this.#phase = 'requesting';
		try {
			await opaque.ready;
			if (revision !== this.#revision) fail('cancelled');
			const descriptor = host.describe(route);
			if (descriptor.protocol !== PROTOCOL) fail('incompatible-host');
			if (trustedHostKey && trustedHostKey !== descriptor.hostKey) fail('host-identity-changed');
			if (route.epoch !== descriptor.epoch) fail('network-changed');
			const secret = token();
			const nonce = token();
			const cancelHash = await hash(secret);
			if (revision !== this.#revision) fail('cancelled');
			const challenge = await host.begin(
				{ clientName: this.#name, clientNonce: nonce, cancelHash, scope: SCOPE },
				route
			);
			if (revision !== this.#revision) {
				await host.cancel(challenge.requestId, secret);
				fail('cancelled');
			}
			if (
				challenge.clientNonce !== nonce ||
				challenge.clientName !== this.#name ||
				challenge.hostKey !== descriptor.hostKey ||
				challenge.endpoint !== origin(route.endpoint) ||
				challenge.transport !== route.source ||
				challenge.epoch !== route.epoch ||
				challenge.scope !== SCOPE ||
				challenge.expiresAt <= this.#now() ||
				challenge.expiresAt > this.#now() + PIN_TTL ||
				!validToken(challenge.hostNonce)
			) {
				await host.cancel(challenge.requestId, secret);
				fail('channel-mismatch');
			}
			this.#cancel = secret;
			this.#challenge = challenge;
			this.#phase = 'awaiting-host';
			return this.view(host);
		} finally {
			this.#busy = false;
		}
	}
	async attempt(host, pin) {
		if (this.#busy) fail('attempt-in-progress');
		if (!/^\d{6}$/.test(pin)) fail('six-digits-required');
		if (!this.#challenge) fail('no-request');
		this.#busy = true;
		this.#error = null;
		try {
			const login = opaque.client.startLogin({ password: pin });
			const response = host.start(this.#challenge.requestId, login.startLoginRequest);
			const result = opaque.client.finishLogin({
				clientLoginState: login.clientLoginState,
				loginResponse: response.loginResponse,
				password: pin,
				identifiers: identifiers(this.#challenge),
			});
			if (!result || result.serverStaticPublicKey !== this.#challenge.hostKey) {
				host.rejectAttempt(this.#challenge.requestId, response.attemptId);
				fail('wrong-pin-or-host');
			}
			const key = await sessionKey(result.sessionKey);
			await host.finish(this.#challenge.requestId, response.attemptId, result.finishLoginRequest);
			// A concurrent cancellation must not restore client secrets or success state.
			if (this.#phase === 'cancelled') fail('cancelled');
			this.#key = key;
			this.#phase = 'awaiting-confirmation';
		} catch (error) {
			this.#error = error.code ?? 'invalid-proof';
			throw error;
		} finally {
			this.#busy = false;
		}
		return this.view(host);
	}
	async claim(host) {
		if (!this.#key || !this.#challenge) fail('no-proof');
		const response = await host.claim(
			this.#challenge.requestId,
			await mac(this.#key, ['claim', binding(this.#challenge)])
		);
		if (
			response.grant.scope !== SCOPE ||
			response.grant.hostKey !== this.#challenge.hostKey ||
			response.grant.requestId !== this.#challenge.requestId ||
			response.grant.binding !== binding(this.#challenge) ||
			response.grant.expiresAt <= this.#now() ||
			!(await verifies(this.#key, response.proof, ['grant', ...grantBody(response.grant)]))
		)
			fail('channel-mismatch');
		if (this.#phase === 'cancelled') fail('cancelled');
		this.#grant = response.grant;
		this.#phase = 'paired';
		this.#error = null;
		return this.view(host);
	}
	async read(host, method = SCOPE) {
		if (!this.#grant || !this.#key) fail('not-paired');
		const counter = this.#counter + 1;
		const response = await host.read(
			this.#grant.id,
			counter,
			method,
			await mac(this.#key, ['operation', ...grantBody(this.#grant), counter, method])
		);
		if (
			!(await verifies(this.#key, response.proof, [
				'result',
				this.#grant.id,
				counter,
				response.value.name,
				response.value.hostKey,
			]))
		)
			fail('channel-mismatch');
		this.#counter = counter;
		return response.value;
	}
	async cancel(host) {
		this.#revision++;
		this.#phase = 'cancelled';
		this.#key = undefined;
		this.#grant = undefined;
		this.#error = null;
		const secret = this.#cancel;
		this.#cancel = undefined;
		if (this.#challenge && secret) await host.cancel(this.#challenge.requestId, secret);
	}
	view(host) {
		const remote = this.#challenge ? host.status(this.#challenge.requestId) : null;
		if (remote && CLOSED.has(remote.state)) {
			this.#phase = remote.state;
			this.#key = undefined;
			this.#grant = undefined;
		}
		return {
			phase: remote?.state ?? this.#phase,
			error: this.#error,
			busy: this.#busy,
			request: remote,
			hostKey: this.#challenge?.hostKey ?? null,
			scope: this.#grant?.scope ?? null,
		};
	}
}
