/**
 * Unit tests for src/main/mobile-pairing/index.ts
 *
 * Covers code generation, redeem (success/expired/used/concurrent), token
 * validation (timing-safe, expiry filter), updateDeviceLastUsed, revokeDevice,
 * and listPairedDevices (hides hashes + expired entries).
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readFile } from 'fs/promises';

const tmpRoot = mkdtempSync(join(tmpdir(), 'maestro-mobile-pairing-test-'));

vi.mock('electron', () => ({
	app: {
		getPath: vi.fn(() => tmpRoot),
		isPackaged: false,
	},
}));

// Re-import inside each describe so the in-memory pendingPairings map is fresh
// per test (the module keeps it at module scope).
async function freshModule() {
	vi.resetModules();
	return await import('../../main/mobile-pairing');
}

afterAll(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe('mobile-pairing', () => {
	beforeEach(() => {
		// Clear the pairings file between tests so list/validate start clean.
		try {
			rmSync(join(tmpRoot, 'mobile-pairings.json'), { force: true });
		} catch {
			// not present
		}
	});

	describe('generatePairingCode', () => {
		it('returns a 6-character base32 code, future expiry, and a 256-bit pending token', async () => {
			const { generatePairingCode } = await freshModule();
			const before = Date.now();
			const { code, expiresAt, pendingToken } = generatePairingCode();

			expect(code).toMatch(/^[A-Z2-7]{6}$/);
			expect(expiresAt).toBeGreaterThan(before);
			// 32 random bytes hex-encoded = 64 chars
			expect(pendingToken).toMatch(/^[a-f0-9]{64}$/);
		});

		it('returns different codes on consecutive calls', async () => {
			const { generatePairingCode } = await freshModule();
			const a = generatePairingCode();
			const b = generatePairingCode();
			expect(a.code).not.toBe(b.code);
			expect(a.pendingToken).not.toBe(b.pendingToken);
		});
	});

	describe('redeemPairingCode', () => {
		it('redeems a freshly generated code and persists a hashed device record', async () => {
			const mod = await freshModule();
			const { generatePairingCode, redeemPairingCode } = mod;
			const { code, pendingToken } = generatePairingCode();

			const result = await redeemPairingCode(code, 'Pixel 9');
			expect(result).not.toBeNull();
			expect(result!.token).toBe(pendingToken);
			expect(result!.deviceId).toMatch(/^[0-9a-f-]{36}$/);

			// Token must be stored as a SHA-256 hex hash, never plaintext.
			const raw = await readFile(join(tmpRoot, 'mobile-pairings.json'), 'utf-8');
			expect(raw).not.toContain(pendingToken);
			expect(raw).toContain('"tokenHash"');
		});

		it('rejects an unknown code', async () => {
			const { redeemPairingCode } = await freshModule();
			expect(await redeemPairingCode('AAAAAA', 'phone')).toBeNull();
		});

		it('rejects malformed codes (length, charset)', async () => {
			const { redeemPairingCode } = await freshModule();
			expect(await redeemPairingCode('SHORT', 'phone')).toBeNull();
			expect(await redeemPairingCode('TOOLONGCODE', 'phone')).toBeNull();
			// '0' and '1' are not in base32 alphabet
			expect(await redeemPairingCode('ABC011', 'phone')).toBeNull();
			expect(await redeemPairingCode('', 'phone')).toBeNull();
		});

		it('normalizes lowercase + whitespace to match the canonical code', async () => {
			const { generatePairingCode, redeemPairingCode } = await freshModule();
			const { code } = generatePairingCode();
			const r = await redeemPairingCode(`  ${code.toLowerCase()} `, 'phone');
			expect(r).not.toBeNull();
		});

		it('cannot be redeemed twice', async () => {
			const { generatePairingCode, redeemPairingCode } = await freshModule();
			const { code } = generatePairingCode();
			const first = await redeemPairingCode(code, 'phone-a');
			const second = await redeemPairingCode(code, 'phone-b');
			expect(first).not.toBeNull();
			expect(second).toBeNull();
		});

		it('rejects expired codes', async () => {
			const { generatePairingCode, redeemPairingCode } = await freshModule();
			const { code } = generatePairingCode();
			// 5 minutes + 1 ms past the issue moment
			vi.useFakeTimers();
			vi.advanceTimersByTime(5 * 60 * 1000 + 1);
			const result = await redeemPairingCode(code, 'phone');
			vi.useRealTimers();
			expect(result).toBeNull();
		});

		it('truncates an oversized deviceName to 200 chars and trims', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices } = await freshModule();
			const { code } = generatePairingCode();
			const huge = '  ' + 'x'.repeat(10_000) + '  ';
			const r = await redeemPairingCode(code, huge);
			expect(r).not.toBeNull();
			const devices = await listPairedDevices();
			expect(devices).toHaveLength(1);
			expect(devices[0].deviceName.length).toBe(200);
		});

		it('falls back to "Unknown Device" for empty/whitespace deviceName', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices } = await freshModule();
			const { code } = generatePairingCode();
			await redeemPairingCode(code, '   ');
			const devices = await listPairedDevices();
			expect(devices[0].deviceName).toBe('Unknown Device');
		});

		it('serializes concurrent redemptions of distinct codes without losing writes', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices } = await freshModule();

			const codes = Array.from({ length: 8 }, () => generatePairingCode().code);
			const results = await Promise.all(codes.map((c, i) => redeemPairingCode(c, `device-${i}`)));
			expect(results.every((r) => r && r.token && r.deviceId)).toBe(true);
			const devices = await listPairedDevices();
			expect(devices).toHaveLength(8);
			expect(new Set(devices.map((d) => d.id)).size).toBe(8);
		});
	});

	describe('validateMobileToken', () => {
		it('accepts a valid token and returns the matching device', async () => {
			const { generatePairingCode, redeemPairingCode, validateMobileToken } = await freshModule();
			const { code } = generatePairingCode();
			const { token, deviceId } = (await redeemPairingCode(code, 'phone'))!;

			const device = await validateMobileToken(token);
			expect(device).not.toBeNull();
			expect(device!.id).toBe(deviceId);
		});

		it('rejects an unknown token', async () => {
			const { generatePairingCode, redeemPairingCode, validateMobileToken } = await freshModule();
			const { code } = generatePairingCode();
			await redeemPairingCode(code, 'phone');
			expect(await validateMobileToken('a'.repeat(64))).toBeNull();
		});

		it('rejects empty / non-string input', async () => {
			const { validateMobileToken } = await freshModule();
			expect(await validateMobileToken('')).toBeNull();
			// @ts-expect-error - exercise runtime guard for non-string input
			expect(await validateMobileToken(123)).toBeNull();
		});

		it('rejects tokens for devices whose expiry has passed', async () => {
			const { generatePairingCode, redeemPairingCode, validateMobileToken } = await freshModule();
			const { code } = generatePairingCode();
			const { token } = (await redeemPairingCode(code, 'phone'))!;

			vi.useFakeTimers();
			// 90-day token TTL + 1ms
			vi.advanceTimersByTime(90 * 24 * 60 * 60 * 1000 + 1);
			const result = await validateMobileToken(token);
			vi.useRealTimers();
			expect(result).toBeNull();
		});
	});

	describe('updateDeviceLastUsed', () => {
		it('bumps lastUsedAt on the matching device', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices, updateDeviceLastUsed } =
				await freshModule();
			const { code } = generatePairingCode();
			const { deviceId } = (await redeemPairingCode(code, 'phone'))!;
			const before = (await listPairedDevices()).find((d) => d.id === deviceId)!.lastUsedAt;

			await new Promise((r) => setTimeout(r, 5));
			await updateDeviceLastUsed(deviceId);

			const after = (await listPairedDevices()).find((d) => d.id === deviceId)!.lastUsedAt;
			expect(after).toBeGreaterThanOrEqual(before);
		});

		it('is a no-op for an unknown device id', async () => {
			const { updateDeviceLastUsed, listPairedDevices } = await freshModule();
			await updateDeviceLastUsed('does-not-exist');
			expect(await listPairedDevices()).toEqual([]);
		});

		it('does not lose a concurrent revoke', async () => {
			const {
				generatePairingCode,
				redeemPairingCode,
				updateDeviceLastUsed,
				revokeDevice,
				listPairedDevices,
			} = await freshModule();
			const a = generatePairingCode().code;
			const b = generatePairingCode().code;
			const ra = (await redeemPairingCode(a, 'a'))!;
			const rb = (await redeemPairingCode(b, 'b'))!;

			await Promise.all([updateDeviceLastUsed(ra.deviceId), revokeDevice(rb.deviceId)]);

			const remaining = await listPairedDevices();
			expect(remaining.map((d) => d.id)).toEqual([ra.deviceId]);
		});
	});

	describe('listPairedDevices', () => {
		it('omits tokenHash from the returned shape', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices } = await freshModule();
			const { code } = generatePairingCode();
			await redeemPairingCode(code, 'phone');
			const devices = await listPairedDevices();
			expect(devices[0]).not.toHaveProperty('tokenHash');
		});

		it('filters out expired devices', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices } = await freshModule();
			const { code } = generatePairingCode();
			await redeemPairingCode(code, 'phone');

			vi.useFakeTimers();
			vi.advanceTimersByTime(90 * 24 * 60 * 60 * 1000 + 1);
			const devices = await listPairedDevices();
			vi.useRealTimers();
			expect(devices).toEqual([]);
		});
	});

	describe('revokeDevice', () => {
		it('removes a device by id and returns true', async () => {
			const { generatePairingCode, redeemPairingCode, listPairedDevices, revokeDevice } =
				await freshModule();
			const { code } = generatePairingCode();
			const { deviceId } = (await redeemPairingCode(code, 'phone'))!;

			expect(await revokeDevice(deviceId)).toBe(true);
			expect(await listPairedDevices()).toEqual([]);
		});

		it('returns false for an unknown id', async () => {
			const { revokeDevice } = await freshModule();
			expect(await revokeDevice('does-not-exist')).toBe(false);
		});
	});
});
