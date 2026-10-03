import test from 'node:test';
import assert from 'node:assert/strict';
import * as opaque from '@serenity-kit/opaque';
import { PairingHost, PairingClient, PIN_TTL, GRANT_TTL, identifiers } from '../pairing.mjs';
import { Buffer } from 'node:buffer';
const route = { endpoint: 'https://aster.local:8443', source: 'lan', epoch: 1 };
const code = (expected) => (error) => error.code === expected;
async function fixture() {
	let time = 1000000;
	const now = () => time;
	const host = await PairingHost.create({
		name: 'Aster studio',
		endpoints: [route.endpoint, 'https://aster.demo.ts.net'],
		now,
	});
	const client = new PairingClient({ now });
	return {
		host,
		client,
		now,
		advance: (value) => {
			time += value;
		},
	};
}
async function pinRequest(f, client = f.client, selected = route) {
	const state = await client.begin(f.host, selected);
	const id = state.request.requestId;
	f.host.approvePin(id);
	return { id, pin: f.host.hostScreen().find((row) => row.requestId === id).pin };
}
async function pair(f) {
	const { id, pin } = await pinRequest(f);
	await f.client.attempt(f.host, pin);
	f.host.confirm(id);
	await f.client.claim(f.host);
	return { id, pin };
}

test('host approval, one-time proof, final consent, scoped read and grant expiry', async () => {
	const f = await fixture();
	const initial = await f.client.begin(f.host, route);
	const id = initial.request.requestId;
	assert.equal(f.host.hostScreen()[0].pin, null);
	await assert.rejects(f.client.attempt(f.host, '123456'), code('invalid-state'));
	f.host.approvePin(id);
	const pin = f.host.hostScreen()[0].pin;
	assert.equal('pin' in f.host.status(id), false);
	assert.equal('record' in f.host.status(id), false);
	await f.client.attempt(f.host, pin);
	assert.equal(f.host.hostScreen()[0].pin, null);
	await assert.rejects(f.client.claim(f.host), code('invalid-state'));
	f.host.confirm(id);
	await f.client.claim(f.host);
	assert.deepEqual(await f.client.read(f.host), {
		name: 'Aster studio',
		hostKey: f.host.describe(route).hostKey,
	});
	await assert.rejects(f.client.read(f.host, 'agents.execute'), code('forbidden'));
	await assert.rejects(f.client.attempt(f.host, pin), code('invalid-state'));
	f.advance(GRANT_TTL);
	await assert.rejects(f.client.read(f.host), code('expired-or-revoked'));
});
test('five wrong PINs lock the request; no plaintext PIN is exposed to Lite', async () => {
	const f = await fixture();
	const { pin } = await pinRequest(f);
	const wrong = pin === '000000' ? '000001' : '000000';
	for (let i = 0; i < 5; i++)
		await assert.rejects(f.client.attempt(f.host, wrong), code('wrong-pin-or-host'));
	assert.equal(f.client.view(f.host).phase, 'locked');
	assert.equal(f.host.hostScreen()[0].pin, null);
	await assert.rejects(f.client.attempt(f.host, pin), code('locked'));
});
test('expired PIN requires a fresh request and explicit host approval', async () => {
	const f = await fixture();
	const first = await pinRequest(f);
	f.advance(PIN_TTL);
	await assert.rejects(f.client.attempt(f.host, first.pin), code('expired'));
	assert.equal(f.client.view(f.host).phase, 'expired');
	const next = await f.client.begin(f.host, route);
	assert.notEqual(next.request.requestId, first.id);
	assert.equal(next.phase, 'awaiting-host');
});
test('a forged name cannot replace a saved host identity', async () => {
	const f = await fixture();
	const fake = await PairingHost.create({ name: 'Aster studio', endpoints: [route.endpoint] });
	await assert.rejects(
		f.client.begin(fake, route, f.host.describe(route).hostKey),
		code('host-identity-changed')
	);
	assert.deepEqual(fake.hostScreen(), []);
});
test('altered origin in authenticated identifiers breaks PAKE even with the right PIN', async () => {
	const f = await fixture();
	let challenge;
	const begin = f.host.begin.bind(f.host);
	f.host.begin = (...args) => {
		challenge = begin(...args);
		return challenge;
	};
	const { id, pin } = await pinRequest(f);
	const login = opaque.client.startLogin({ password: pin });
	const response = f.host.start(id, login.startLoginRequest);
	const finish = opaque.client.finishLogin({
		password: pin,
		clientLoginState: login.clientLoginState,
		loginResponse: response.loginResponse,
		identifiers: identifiers({ ...challenge, endpoint: 'https://lookalike.example.test' }),
	});
	assert.equal(finish, undefined);
	f.host.rejectAttempt(id, response.attemptId);
	assert.equal(f.host.status(id).state, 'pin-issued');
});
test('concurrent requests have separate PINs and confirmation; pending cap is enforced', async () => {
	const f = await fixture();
	const a = await pinRequest(f);
	const second = new PairingClient({ name: 'Second laptop', now: f.now });
	const b = await pinRequest(f, second);
	assert.notEqual(a.pin, b.pin);
	await assert.rejects(second.attempt(f.host, a.pin), code('wrong-pin-or-host'));
	await second.attempt(f.host, b.pin);
	f.host.confirm(b.id);
	await second.claim(f.host);
	assert.equal(f.host.status(a.id).state, 'pin-issued');
	for (let i = 0; i < 3; i++) await new PairingClient({ now: f.now }).begin(f.host, route);
	await assert.rejects(new PairingClient({ now: f.now }).begin(f.host, route), code('host-busy'));
});
test('cancellation while begin yields does not create a live request', async () => {
	const f = await fixture();
	const pending = f.client.begin(f.host, route);
	await f.client.cancel(f.host);
	await assert.rejects(pending, code('cancelled'));
	assert.equal(f.client.view(f.host).phase, 'cancelled');
	assert.equal(
		f.host.hostScreen().filter((row) => !['cancelled', 'expired'].includes(row.state)).length,
		0
	);
});
test('cancelling before a delayed challenge reply revokes the host request when it arrives', async () => {
	const f = await fixture();
	const begin = f.host.begin.bind(f.host);
	let release, received;
	const created = new Promise((resolve) => {
		received = resolve;
	});
	f.host.begin = (...args) => {
		const challenge = begin(...args);
		received();
		return new Promise((resolve) => {
			release = () => resolve(challenge);
		});
	};
	const pending = f.client.begin(f.host, route);
	await created;
	await f.client.cancel(f.host);
	release();
	await assert.rejects(pending, code('cancelled'));
	assert.equal(f.host.hostScreen()[0].state, 'cancelled');
});
test('host cancellation during key import cannot resurrect a proved request', async () => {
	const f = await fixture();
	const { id, pin } = await pinRequest(f);
	const finish = f.host.finish.bind(f.host);
	f.host.finish = (...args) => {
		const pending = finish(...args);
		f.host.cancelLocally(id);
		return pending;
	};
	await assert.rejects(f.client.attempt(f.host, pin), code('cancelled'));
	assert.equal(f.client.view(f.host).phase, 'cancelled');
	await assert.rejects(f.client.claim(f.host), code('no-proof'));
});
test('cancellation needs the request capability; cancelling a paired client revokes access', async () => {
	const f = await fixture();
	const { id } = await pair(f);
	await assert.rejects(
		f.host.cancel(id, Buffer.alloc(32).toString('base64')),
		code('invalid-cancellation')
	);
	assert.equal((await f.client.read(f.host)).name, 'Aster studio');
	await f.client.cancel(f.host);
	await assert.rejects(f.client.read(f.host), code('not-paired'));
	assert.equal(f.host.status(id).state, 'cancelled');
	await f.client.cancel(f.host);
	const retry = await f.client.begin(f.host, route);
	assert.equal(retry.phase, 'awaiting-host');
	assert.notEqual(retry.request.requestId, id);
});
test('global request throttle survives rotating client labels and cancellation', async () => {
	const f = await fixture();
	for (let i = 0; i < 8; i++) {
		const client = new PairingClient({ name: 'Laptop ' + i, now: f.now });
		await client.begin(f.host, route);
		await client.cancel(f.host);
	}
	await assert.rejects(
		new PairingClient({ now: f.now }).begin(f.host, route),
		code('request-throttled')
	);
	f.advance(60001);
	assert.equal(
		(await new PairingClient({ now: f.now }).begin(f.host, route)).phase,
		'awaiting-host'
	);
});
test('global PAKE limit is independent of per-request PIN guess budgets', async () => {
	const f = await fixture();
	let last;
	for (const count of [5, 5, 2]) {
		const client = new PairingClient({ now: f.now });
		const { id } = await pinRequest(f, client);
		last = id;
		for (let i = 0; i < count; i++)
			assert.throws(() => f.host.start(id, 'malformed'), code('invalid-proof'));
	}
	assert.throws(() => f.host.start(last, 'malformed'), code('attempt-throttled'));
});
test('a consumed KE3 and duplicate operation counter cannot be replayed', async () => {
	const f = await fixture();
	let captured;
	const finish = f.host.finish.bind(f.host);
	f.host.finish = (...args) => {
		captured = args;
		return finish(...args);
	};
	await pair(f);
	await assert.rejects(finish(...captured), code('invalid-state'));
	const read = f.host.read.bind(f.host);
	let results;
	f.host.read = async (...args) => {
		results = await Promise.allSettled([read(...args), read(...args)]);
		return results.find((row) => row.status === 'fulfilled').value;
	};
	await f.client.read(f.host);
	assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);
	assert.equal(results.find((row) => row.status === 'rejected').reason.code, 'replay');
});
test('network generation invalidates grants and stale routes', async () => {
	const f = await fixture();
	await pair(f);
	f.host.networkChanged();
	await assert.rejects(f.client.read(f.host), code('expired-or-revoked'));
	assert.equal(f.client.view(f.host).phase, 'network-changed');
	await assert.rejects(
		new PairingClient({ now: f.now }).begin(f.host, route),
		code('network-changed')
	);
});
test('transport fallback needs a new ceremony bound to the same saved identity', async () => {
	const f = await fixture();
	const { id } = await pinRequest(f);
	await f.client.cancel(f.host);
	const fallback = { endpoint: 'https://aster.demo.ts.net', source: 'tailscale', epoch: 1 };
	const next = await f.client.begin(f.host, fallback, f.host.describe(route).hostKey);
	assert.notEqual(next.request.requestId, id);
	assert.equal(next.request.endpoint, fallback.endpoint);
	assert.equal(next.phase, 'awaiting-host');
	await f.client.cancel(f.host);
	await assert.rejects(
		f.client.begin(f.host, { ...fallback, endpoint: 'http://aster.demo.ts.net' }),
		/HTTPS/
	);
});
test('a substituted grant scope is rejected instead of establishing a session', async () => {
	const f = await fixture();
	const { id, pin } = await pinRequest(f);
	await f.client.attempt(f.host, pin);
	f.host.confirm(id);
	const claim = f.host.claim.bind(f.host);
	f.host.claim = async (...args) => {
		const response = await claim(...args);
		response.grant.scope = 'agents.execute';
		return response;
	};
	await assert.rejects(f.client.claim(f.host), code('channel-mismatch'));
	await assert.rejects(f.client.read(f.host), code('not-paired'));
});
