import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { rename } from 'node:fs/promises';
const protection = vi.hoisted(() => ({ available: true }));
vi.mock('electron', async () => {
	const { createCipheriv, createDecipheriv } = await import('node:crypto');
	const key = Buffer.alloc(32, 7),
		iv = Buffer.alloc(12, 8);
	return {
		safeStorage: {
			isEncryptionAvailable: () => protection.available,
			getSelectedStorageBackend: () => 'secret_service',
			encryptString: (text: string) => {
				const c = createCipheriv('aes-256-gcm', key, iv);
				const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
				return Buffer.concat([c.getAuthTag(), body]);
			},
			decryptString: (bytes: Buffer) => {
				const d = createDecipheriv('aes-256-gcm', key, iv);
				d.setAuthTag(bytes.subarray(0, 16));
				return Buffer.concat([d.update(bytes.subarray(16)), d.final()]).toString('utf8');
			},
		},
	};
});
vi.mock('node:fs/promises', async (original) => {
	const fs = await original<typeof import('node:fs/promises')>();
	return { ...fs, rename: vi.fn(fs.rename) };
});
import { DeviceCredentials } from '../../../main/lite/device-credentials';
import { PairedDevices } from '../../../main/lite/pairing/paired-devices';
let directory: string;
const origin = 'https://aster.synthetic.ts.net',
	first = 'A'.repeat(43) + '.' + 'B'.repeat(43),
	second = 'C'.repeat(43) + '.' + 'D'.repeat(43);
beforeEach(() => {
	directory = mkdtempSync(path.join(tmpdir(), 'lite-credential-'));
	protection.available = true;
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe('OS-protected paired device persistence', () => {
	it('does not roll back a newer successful save when an earlier concurrent write fails', async () => {
		const store = new DeviceCredentials(directory);
		await store.get('aster-id', origin);
		vi.mocked(rename).mockRejectedValueOnce(new Error('Synthetic disk failure'));
		const results = await Promise.allSettled([
			store.save('aster-id', origin, first),
			store.save('aster-id', origin, second),
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
		expect(await store.get('aster-id', origin)).toBe(second);
		expect(await new DeviceCredentials(directory).get('aster-id', origin)).toBe(second);
	});
	it('restores only the same host/origin and forgets without deleting a newer credential', async () => {
		const store = new DeviceCredentials(directory);
		await store.save('aster-id', origin, first);
		const disk = readFileSync(path.join(directory, 'lite-device-credentials.json'), 'utf8');
		expect(disk).not.toContain(first);
		expect(disk).not.toContain('B'.repeat(43));
		const restarted = new DeviceCredentials(directory);
		expect(await restarted.get('aster-id', origin)).toBe(first);
		await expect(restarted.get('changed-id', origin)).rejects.toThrow('identity changed');
		expect(await restarted.get('aster-id', 'https://different.synthetic.ts.net')).toBeUndefined();
		await restarted.save('aster-id', origin, second);
		await restarted.forget(origin, first);
		expect(await restarted.get('aster-id', origin)).toBe(second);
		await restarted.forget(origin);
		expect(await new DeviceCredentials(directory).get('aster-id', origin)).toBeUndefined();
	});
	it('refuses pairing storage when OS protection is unavailable, without a plaintext fallback', async () => {
		protection.available = false;
		const store = new DeviceCredentials(directory);
		await expect(store.get('aster-id', origin)).rejects.toThrow('credential store');
		await expect(store.save('aster-id', origin, first)).rejects.toThrow('credential store');
		expect(existsSync(path.join(directory, 'lite-device-credentials.json'))).toBe(false);
	});
	it('pins direct credentials to the locally authenticated Tailscale node identity', async () => {
		const store = new DeviceCredentials(directory),
			direct = 'http://100.64.0.10:56036';
		await store.save('aster-id', direct, first, 'host-node');
		const restarted = new DeviceCredentials(directory);
		expect(await restarted.get('aster-id', direct, 'host-node')).toBe(first);
		await expect(restarted.get('aster-id', direct, 'replacement-node')).rejects.toThrow('identity');
		await expect(restarted.get('aster-id', direct)).rejects.toThrow('node identity');
	});
});
describe('host paired device persistence', () => {
	it('revokes live access immediately while waiting for another pairing write', async () => {
		const store = new PairedDevices(directory);
		await store.add(first, 'First device', 'aster-id', origin);
		let finishWrite!: () => void;
		const persist = vi.mocked(rename).getMockImplementation()!;
		vi.mocked(rename).mockImplementationOnce(async (...args) => {
			await new Promise<void>((resolve) => (finishWrite = resolve));
			return persist(...args);
		});
		const adding = store.add(second, 'Second device', 'aster-id', origin);
		await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'));
		const revoking = store.revoke(first.split('.')[0]);
		expect(store.resolve(first, 'aster-id', origin)).toBeUndefined();
		finishWrite();
		await Promise.all([adding, revoking]);
		const restarted = new PairedDevices(directory);
		await restarted.load();
		expect(restarted.resolve(first, 'aster-id', origin)).toBeUndefined();
		expect(restarted.resolve(second, 'aster-id', origin)?.name).toBe('Second device');
	});
	it('does not persist a failed pairing through a later concurrent successful write', async () => {
		const store = new PairedDevices(directory);
		await store.load();
		vi.mocked(rename).mockRejectedValueOnce(new Error('Synthetic disk failure'));
		const results = await Promise.allSettled([
			store.add(first, 'First device', 'aster-id', origin),
			store.add(second, 'Second device', 'aster-id', origin),
		]);
		expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled']);
		expect(store.resolve(first, 'aster-id', origin)).toBeUndefined();
		const restarted = new PairedDevices(directory);
		await restarted.load();
		expect(restarted.resolve(first, 'aster-id', origin)).toBeUndefined();
		expect(restarted.resolve(second, 'aster-id', origin)?.name).toBe('Second device');
	});
});
