/**
 * Device pairing.
 *
 * The security model is the thing under test, not the happy path:
 *
 *   - a code expires, and it is consumed by the FIRST claim whatever happens
 *     next, so a denied request cannot leave a live code behind;
 *   - a code alone pairs nothing - a human on the desktop has to approve;
 *   - the long-lived token is never written to disk in plain text;
 *   - revocation fires immediately, before the write completes, because the one
 *     situation anybody ever uses it in is a device that is connected right now.
 *
 * The clock is injected and the file is a temp directory, so nothing here sleeps
 * and nothing here touches the real user data path.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import { readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	DEFAULT_PAIRING_TTL_MS,
	PairingService,
	constantTimeEquals,
	generatePairingCode,
	hashToken,
} from '../../../main/acappella/pairing/pairing-service';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;
let filePath: string;
let now = 1_000_000;

function createService(overrides: { hostSecret?: string } = {}): PairingService {
	return new PairingService({
		filePath,
		hostSecret: overrides.hostSecret ?? 'server-token',
		now: () => now,
	});
}

/** Walk a device all the way to a token: claim, approve, redeem. */
async function pairDevice(
	service: PairingService,
	name = 'Test iPhone'
): Promise<{ deviceId: string; token: string }> {
	const offer = service.startPairing();
	const claim = service.claim({ code: offer.code, name, platform: 'ios' });
	if (claim.status !== 'pending') throw new Error(`claim failed: ${claim.reason}`);
	await service.approve(claim.requestId);
	const redeemed = service.redeem(claim.requestId);
	if (redeemed.status !== 'approved') throw new Error(`redeem failed: ${redeemed.status}`);
	return { deviceId: redeemed.deviceId, token: redeemed.token };
}

beforeEach(async () => {
	now = 1_000_000;
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-pairing-'));
	filePath = path.join(dir, 'devices.json');
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe('pairing codes', () => {
	it('draws codes from an alphabet with no lookalike glyphs', () => {
		for (let attempt = 0; attempt < 50; attempt += 1) {
			expect(generatePairingCode()).toMatch(/^[2-9BCDFGHJKMNPQRSTVWXYZ]{6}$/);
		}
	});

	it('expires the window without anyone touching it', () => {
		const service = createService();
		service.startPairing();
		expect(service.currentOffer()).not.toBeNull();
		now += DEFAULT_PAIRING_TTL_MS + 1;
		expect(service.currentOffer()).toBeNull();
	});

	it('refuses a claim against an expired code', () => {
		const service = createService();
		const offer = service.startPairing();
		now += DEFAULT_PAIRING_TTL_MS + 1;
		expect(service.claim({ code: offer.code, name: 'Late', platform: 'ios' })).toEqual({
			status: 'rejected',
			reason: 'expired',
		});
	});

	it('refuses a wrong code', () => {
		const service = createService();
		service.startPairing();
		expect(service.claim({ code: 'ZZZZZZ', name: 'Guess', platform: 'ios' })).toMatchObject({
			status: 'rejected',
			reason: 'unknown-code',
		});
	});

	it('consumes the code on the first claim, even when the human denies it', () => {
		const service = createService();
		const offer = service.startPairing();
		const first = service.claim({ code: offer.code, name: 'First', platform: 'ios' });
		expect(first.status).toBe('pending');
		if (first.status !== 'pending') return;

		service.deny(first.requestId);
		// The shoulder-surfer's turn. A denied request must not leave a live code.
		expect(service.claim({ code: offer.code, name: 'Second', platform: 'ios' })).toMatchObject({
			status: 'rejected',
		});
	});

	it('shows the same fingerprint for the same host secret and a different one otherwise', () => {
		expect(createService({ hostSecret: 'a' }).fingerprint()).toBe(
			createService({ hostSecret: 'a' }).fingerprint()
		);
		expect(createService({ hostSecret: 'a' }).fingerprint()).not.toBe(
			createService({ hostSecret: 'b' }).fingerprint()
		);
	});
});

describe('desktop approval', () => {
	it('hands out nothing until a human approves', async () => {
		const service = createService();
		const offer = service.startPairing();
		const claim = service.claim({ code: offer.code, name: 'iPhone', platform: 'ios' });
		expect(claim.status).toBe('pending');
		if (claim.status !== 'pending') return;

		// The whole point: the code is known and the device still cannot connect.
		expect(service.redeem(claim.requestId)).toEqual({ status: 'pending' });
		expect(await service.list()).toHaveLength(0);

		await service.approve(claim.requestId);
		const redeemed = service.redeem(claim.requestId);
		expect(redeemed.status).toBe('approved');
	});

	it('reports the waiting request so the desktop can render it', () => {
		const service = createService();
		const seen: Array<string | null> = [];
		service.onPairingRequest((request) => seen.push(request?.name ?? null));
		const offer = service.startPairing();
		service.claim({ code: offer.code, name: 'Pedram iPhone', platform: 'ios' });
		expect(service.pendingRequest()?.name).toBe('Pedram iPhone');
		expect(seen).toContain('Pedram iPhone');
	});

	it('returns nothing at all on a denial', () => {
		const service = createService();
		const offer = service.startPairing();
		const claim = service.claim({ code: offer.code, name: 'iPhone', platform: 'ios' });
		if (claim.status !== 'pending') throw new Error('claim failed');
		service.deny(claim.requestId);
		expect(service.redeem(claim.requestId)).toEqual({ status: 'denied' });
	});

	it('redeems exactly once', async () => {
		const service = createService();
		const offer = service.startPairing();
		const claim = service.claim({ code: offer.code, name: 'iPhone', platform: 'ios' });
		if (claim.status !== 'pending') throw new Error('claim failed');
		await service.approve(claim.requestId);

		expect(service.redeem(claim.requestId).status).toBe('approved');
		// A replayed redemption gets nothing: the token is deleted as it is handed
		// over, so it exists in memory for one call and no longer.
		expect(service.redeem(claim.requestId).status).toBe('expired');
	});

	it('lets the desktop rename the device at approval time', async () => {
		const service = createService();
		const offer = service.startPairing();
		const claim = service.claim({ code: offer.code, name: 'iPhone', platform: 'ios' });
		if (claim.status !== 'pending') throw new Error('claim failed');
		const device = await service.approve(claim.requestId, 'Walking phone');
		expect(device?.name).toBe('Walking phone');
	});
});

describe('token storage', () => {
	it('never writes the token in plain text', async () => {
		const service = createService();
		const { token } = await pairDevice(service);

		const raw = await fs.readFile(filePath, 'utf-8');
		expect(raw).not.toContain(token);
		const parsed = JSON.parse(raw) as { devices: Array<Record<string, unknown>> };
		expect(parsed.devices[0].tokenHash).toEqual(expect.any(String));
		expect(parsed.devices[0].tokenHash).not.toBe(token);
	});

	it('salts per device, so two devices with the same token would not collide', async () => {
		const service = createService();
		await pairDevice(service, 'One');
		await pairDevice(service, 'Two');
		const parsed = JSON.parse(await fs.readFile(filePath, 'utf-8')) as {
			devices: Array<{ tokenSalt: string }>;
		};
		expect(parsed.devices[0].tokenSalt).not.toBe(parsed.devices[1].tokenSalt);
		expect(hashToken('same', 'a')).not.toBe(hashToken('same', 'b'));
	});

	it('authenticates a returning device from the stored hash alone', async () => {
		const service = createService();
		const { deviceId, token } = await pairDevice(service);

		// A fresh service, as after a restart: nothing in memory, only the file.
		const restarted = createService();
		expect(await restarted.authenticate(deviceId, token)).toMatchObject({ id: deviceId });
	});

	it('refuses a wrong token and an unknown device the same way', async () => {
		const service = createService();
		const { deviceId } = await pairDevice(service);
		expect(await service.authenticate(deviceId, 'wrong')).toBeNull();
		expect(await service.authenticate('no-such-device', 'wrong')).toBeNull();
	});

	it('compares in constant time without throwing on a length mismatch', () => {
		expect(constantTimeEquals('abc', 'abc')).toBe(true);
		expect(constantTimeEquals('abc', 'abcdefghij')).toBe(false);
	});

	it('survives a corrupt device file rather than refusing to run', async () => {
		await fs.writeFile(filePath, 'not json at all', 'utf-8');
		const service = createService();
		expect(await service.list()).toEqual([]);
	});
});

describe('revocation', () => {
	it('fires before the write lands, so a live peer is not held up by a disk flush', async () => {
		const service = createService();
		const { deviceId, token } = await pairDevice(service);

		const torn: string[] = [];
		/** What was on disk at the moment the teardown listener ran. */
		let diskAtTeardown = '';
		service.onRevoke((id) => {
			torn.push(id);
			diskAtTeardown = readFileSync(filePath, 'utf-8');
		});

		await service.revoke(deviceId);

		expect(torn).toEqual([deviceId]);
		// The file still said the device was live when the peer was torn down: the
		// urgent half does not wait on a disk flush. A revocation that did would
		// leave a revoked phone holding the microphone while a slow disk caught up.
		expect(JSON.parse(diskAtTeardown).devices[0].revokedAt).toBeNull();
		expect(await service.authenticate(deviceId, token)).toBeNull();
	});

	it('refuses the revoked device on its next attempt', async () => {
		const service = createService();
		const { deviceId, token } = await pairDevice(service);
		expect(await service.authenticate(deviceId, token)).not.toBeNull();

		await service.revoke(deviceId);
		expect(await service.authenticate(deviceId, token)).toBeNull();

		// And after a restart, because the revocation is persisted rather than held
		// in the memory of the process that performed it.
		expect(await createService().authenticate(deviceId, token)).toBeNull();
	});

	it('is idempotent', async () => {
		const service = createService();
		const { deviceId } = await pairDevice(service);
		expect(await service.revoke(deviceId)).toBe(true);
		expect(await service.revoke(deviceId)).toBe(false);
	});

	it('revokes everything at once and reports how many', async () => {
		const service = createService();
		await pairDevice(service, 'One');
		await pairDevice(service, 'Two');
		const torn: string[] = [];
		service.onRevoke((id) => torn.push(id));

		expect(await service.revokeAll()).toBe(2);
		expect(torn).toHaveLength(2);
		expect(await service.revokeAll()).toBe(0);
	});

	it('keeps a revoked device visible until it is explicitly forgotten', async () => {
		const service = createService();
		const { deviceId } = await pairDevice(service);
		await service.revoke(deviceId);
		expect(await service.list()).toHaveLength(1);
		expect(await service.forget(deviceId)).toBe(true);
		expect(await service.list()).toHaveLength(0);
	});
});

describe('device list', () => {
	it('records how a device last connected', async () => {
		const service = createService();
		const { deviceId } = await pairDevice(service);
		await service.noteConnected(deviceId, 'relay');
		const [device] = await service.list();
		expect(device.lastCandidateType).toBe('relay');
		expect(device.lastConnectedAt).toBe(now);
	});

	it('renames', async () => {
		const service = createService();
		const { deviceId } = await pairDevice(service);
		expect(await service.rename(deviceId, 'Bedroom phone')).toBe(true);
		expect((await service.list())[0].name).toBe('Bedroom phone');
	});

	it('never exposes credential material to a caller', async () => {
		const service = createService();
		await pairDevice(service);
		const [device] = await service.list();
		expect(device).not.toHaveProperty('tokenHash');
		expect(device).not.toHaveProperty('tokenSalt');
	});
});
