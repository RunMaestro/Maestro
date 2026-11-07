/**
 * @file config-store.test.ts
 *
 * What the model server keeps between launches: a port chosen once and kept, the
 * bind mode and model count, and a key that is never written as readable text
 * (sealed by the OS, or obscured where the OS offers nothing), refused by name
 * when it cannot be unsealed, and replaced on rotate. A file that is not JSON is
 * moved aside, not overwritten.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const logger = vi.hoisted(() => ({
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock('../../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import { ModelServerError } from '../../../../main/local-models/errors';
import {
	ensureModelServerKey,
	ensureModelServerPort,
	MODEL_SERVER_KEY_PREFIX,
	MODEL_SERVER_STATE_FILE,
	readModelServerConfig,
	rotateModelServerKey,
	writeModelServerSettings,
} from '../../../../main/local-models/server/config-store';
import { safeStorageSeal, type SealProvider } from '../../../../main/utils/safe-storage-seal';
import { isTcpPort } from '../../../../main/utils/tcp-port';

let dir: string;

beforeEach(async () => {
	vi.clearAllMocks();
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-server-config-'));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const stateFile = () => path.join(dir, MODEL_SERVER_STATE_FILE);
const readFile = async () => JSON.parse(await fs.readFile(stateFile(), 'utf-8'));

/** An OS seal that marks what it sealed, so a test can tell which seal was used. */
function osSeal(available = true): SealProvider {
	return {
		available: () => available,
		seal: (text) => Buffer.from(`os-sealed:${Buffer.from(text).toString('hex')}`),
		unseal: (blob) => {
			const text = blob.toString();
			if (!text.startsWith('os-sealed:')) throw new Error('not sealed by this OS key');
			return Buffer.from(text.slice('os-sealed:'.length), 'hex').toString();
		},
	};
}

describe('readModelServerConfig', () => {
	it('reports the defaults, and writes nothing, before the server was ever started', async () => {
		expect(await readModelServerConfig(dir)).toEqual({
			port: null,
			bind: 'local',
			maxModels: 1,
			keyStorage: null,
		});
		await expect(fs.access(stateFile())).rejects.toThrow();
	});

	it('drops a field it cannot use and keeps the rest', async () => {
		await fs.writeFile(
			stateFile(),
			JSON.stringify({ port: 'eighty', bind: 'lan', maxModels: 0, key: { sealed: 7 } })
		);
		expect(await readModelServerConfig(dir)).toEqual({
			port: null,
			bind: 'local',
			maxModels: 1,
			keyStorage: null,
		});
		await fs.writeFile(stateFile(), JSON.stringify({ port: 41234, bind: 'network', maxModels: 2 }));
		expect(await readModelServerConfig(dir)).toMatchObject({
			port: 41234,
			bind: 'network',
			maxModels: 2,
		});
	});

	it('keeps the port of a file a Windows editor saved with a byte-order mark and CRLF line endings', async () => {
		// Notepad and PowerShell's `Set-Content -Encoding UTF8` both write the mark.
		// Read as "not JSON", the file would be moved aside and the port would move.
		await fs.writeFile(
			stateFile(),
			'﻿{\r\n  "port": 41234,\r\n  "bind": "network",\r\n  "maxModels": 2\r\n}\r\n'
		);

		expect(await readModelServerConfig(dir)).toMatchObject({
			port: 41234,
			bind: 'network',
			maxModels: 2,
		});
		expect(await ensureModelServerPort(dir)).toBe(41234);
		expect(await fs.readdir(dir)).toEqual([MODEL_SERVER_STATE_FILE]);
	});

	it('moves a file that is not JSON aside rather than losing it', async () => {
		await fs.writeFile(stateFile(), '{"port": 41234, "key": {');
		expect((await readModelServerConfig(dir)).port).toBeNull();

		const files = await fs.readdir(dir);
		const sidecar = files.find((name) => /^model-server\.corrupt-.+\.json$/.test(name));
		expect(sidecar).toBeDefined();
		expect(await fs.readFile(path.join(dir, sidecar!), 'utf-8')).toBe('{"port": 41234, "key": {');
		expect(files).not.toContain(MODEL_SERVER_STATE_FILE);
	});
});

describe('ensureModelServerPort', () => {
	it('chooses a port once, persists it, and keeps it', async () => {
		const port = await ensureModelServerPort(dir);
		expect(isTcpPort(port)).toBe(true);
		expect((await readFile()).port).toBe(port);

		expect(await ensureModelServerPort(dir)).toBe(port);
		expect((await readModelServerConfig(dir)).port).toBe(port);
	});

	it('never chooses again once a port is persisted', async () => {
		await fs.writeFile(stateFile(), JSON.stringify({ port: 41234 }));
		expect(await ensureModelServerPort(dir)).toBe(41234);
		expect((await readFile()).port).toBe(41234);
	});
});

describe('writeModelServerSettings', () => {
	it('changes the bind mode and the model count, keeping the port and the key', async () => {
		const port = await ensureModelServerPort(dir);
		const { key } = await ensureModelServerKey(dir, osSeal());

		expect(await writeModelServerSettings(dir, { bind: 'network' })).toMatchObject({
			bind: 'network',
			maxModels: 1,
			port,
		});
		expect(await writeModelServerSettings(dir, { maxModels: 3 })).toMatchObject({
			bind: 'network',
			maxModels: 3,
		});
		expect((await ensureModelServerKey(dir, osSeal())).key).toBe(key);
	});

	it('rejects a bind mode or a model count it does not accept, and writes nothing', async () => {
		for (const patch of [
			{ bind: 'everywhere' as never },
			{ maxModels: 0 },
			{ maxModels: 17 },
			{ maxModels: 1.5 },
		]) {
			const error = await writeModelServerSettings(dir, patch).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ModelServerError);
			expect((error as ModelServerError).code).toBe('invalid-setting');
		}
		await expect(fs.access(stateFile())).rejects.toThrow();
	});
});

describe('ensureModelServerKey', () => {
	it('makes a key once, sealed by the OS, and never writes it as readable text', async () => {
		const first = await ensureModelServerKey(dir, osSeal());
		expect(first.storage).toBe('os');
		expect(first.key.startsWith(MODEL_SERVER_KEY_PREFIX)).toBe(true);
		expect(first.key.length).toBeGreaterThan(MODEL_SERVER_KEY_PREFIX.length + 40);

		const raw = await fs.readFile(stateFile(), 'utf-8');
		expect(raw).not.toContain(first.key);
		expect(JSON.parse(raw).key.storage).toBe('os');
		expect((await readModelServerConfig(dir)).keyStorage).toBe('os');

		expect(await ensureModelServerKey(dir, osSeal())).toEqual(first);
	});

	it('obscures the key where the OS offers no encryption, and says so', async () => {
		const made = await ensureModelServerKey(dir, osSeal(false));
		expect(made.storage).toBe('obscured');
		expect(await fs.readFile(stateFile(), 'utf-8')).not.toContain(made.key);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('obscured, not encrypted'),
			expect.any(String)
		);
		// Readable again with no OS seal at all.
		expect((await ensureModelServerKey(dir, osSeal(false))).key).toBe(made.key);
	});

	it('refuses by name a key it cannot unseal, and leaves the file alone', async () => {
		await ensureModelServerKey(dir, osSeal());
		const before = await fs.readFile(stateFile(), 'utf-8');
		const broken: SealProvider = {
			...osSeal(),
			unseal: () => {
				throw new Error('The key store was reset.');
			},
		};

		for (const seal of [broken, osSeal(false)]) {
			const error = await ensureModelServerKey(dir, seal).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ModelServerError);
			expect((error as ModelServerError).code).toBe('key-unavailable');
			expect((error as ModelServerError).message).toContain('Rotate the key');
		}
		expect(await fs.readFile(stateFile(), 'utf-8')).toBe(before);
	});

	it.skipIf(process.platform === 'win32')('keeps the file readable by its owner only', async () => {
		await ensureModelServerKey(dir, osSeal());
		expect((await fs.stat(stateFile())).mode & 0o777).toBe(0o600);
	});
});

describe('the key on a system with no key store (Linux with no keyring)', () => {
	/** Electron's `safeStorage` there: it reports no encryption, and encrypting throws. */
	function linuxWithoutKeyring(check: () => boolean = () => false) {
		return {
			isEncryptionAvailable: vi.fn(check),
			encryptString: vi.fn((): Buffer => {
				throw new Error('Encryption is not available.');
			}),
			decryptString: vi.fn((): string => {
				throw new Error('Decryption is not available.');
			}),
		};
	}

	it('obscures the key through the production seal, and never asks the missing key store', async () => {
		const electron = linuxWithoutKeyring();

		const made = await ensureModelServerKey(dir, safeStorageSeal(electron));

		expect(made.storage).toBe('obscured');
		expect(electron.encryptString).not.toHaveBeenCalled();
		expect(await fs.readFile(stateFile(), 'utf-8')).not.toContain(made.key);
		expect((await readModelServerConfig(dir)).keyStorage).toBe('obscured');
		expect((await ensureModelServerKey(dir, safeStorageSeal(electron))).key).toBe(made.key);
		expect(electron.decryptString).not.toHaveBeenCalled();
	});

	it('treats a check that throws as no key store', async () => {
		// Asking Electron before the app is ready fails outright on Linux.
		const electron = linuxWithoutKeyring(() => {
			throw new Error('safeStorage cannot be used before app is ready');
		});

		expect((await ensureModelServerKey(dir, safeStorageSeal(electron))).storage).toBe('obscured');
		expect(electron.encryptString).not.toHaveBeenCalled();
	});
});

describe('rotateModelServerKey', () => {
	it('replaces the key, and the old one is gone', async () => {
		const old = await ensureModelServerKey(dir, osSeal());
		const rotated = await rotateModelServerKey(dir, osSeal());

		expect(rotated.key).not.toBe(old.key);
		expect((await ensureModelServerKey(dir, osSeal())).key).toBe(rotated.key);
	});

	it('makes a key that can be read when the old one could not', async () => {
		await ensureModelServerKey(dir, osSeal());
		const fresh = await rotateModelServerKey(dir, osSeal(false));
		expect(fresh.storage).toBe('obscured');
		expect((await ensureModelServerKey(dir, osSeal(false))).key).toBe(fresh.key);
	});
});
