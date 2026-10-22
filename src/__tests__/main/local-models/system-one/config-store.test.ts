/**
 * @file config-store.test.ts
 *
 * What System One keeps between launches: the engine choice and its settings,
 * and one key per remote engine that is never written as readable text.
 * Properties worth protecting:
 *
 *   - **Off, and no file, until something is chosen.**
 *   - **A settings change never touches a key**, and a key change never touches
 *     the settings.
 *   - **A key that will not open is reported as that and left in place.**
 *   - **A refused change writes nothing.**
 *   - **A Test pass belongs to one engine and one key**: a settings change keeps
 *     it, a key change for that engine drops it, and no settings read returns it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import {
	SYSTEM_ONE_STATE_FILE,
	clearSystemOneKey,
	clearSystemOneTestPass,
	readSystemOneSettings,
	readSystemOneSetup,
	readSystemOneStoredKey,
	storeSystemOneKey,
	storeSystemOneTestPass,
	updateSystemOneSettings,
	type SystemOneTestPass,
} from '../../../../main/local-models/system-one/config-store';
import type { SealProvider } from '../../../../main/utils/safe-storage-seal';
import { DEFAULT_SYSTEM_ONE_SETTINGS } from '../../../../shared/local-models/system-one-settings';

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'system-one-config-'));
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

const stateFile = () => path.join(dir, SYSTEM_ONE_STATE_FILE);
const rawFile = () => fs.readFile(stateFile(), 'utf-8');

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

const JEV_KEY = 'sk-jev-0123456789abcdef';
const OPEN_KEY = 'openjev-key-fedcba9876543210';

describe('settings', () => {
	it('reads as off, and writes nothing, on a machine that never set System One up', async () => {
		expect(await readSystemOneSettings(dir)).toEqual(DEFAULT_SYSTEM_ONE_SETTINGS);
		await expect(fs.access(stateFile())).rejects.toThrow();
	});

	it('stores a change and reads it back', async () => {
		const next = await updateSystemOneSettings(dir, (current) => ({
			...current,
			engine: 'openjev',
			openJevUrl: 'https://gpu.lan:8000',
			timeoutMs: 900,
			models: { openjev: 'openjev-1' },
			failPolicies: { 'cue-gate': 'closed' },
		}));
		expect(await readSystemOneSettings(dir)).toEqual(next);
		expect(next.engine).toBe('openjev');
	});

	it('writes nothing when a change is refused', async () => {
		await updateSystemOneSettings(dir, (current) => ({ ...current, engine: 'jev-cloud' }));
		const before = await rawFile();
		await expect(
			updateSystemOneSettings(dir, () => {
				throw new Error('refused');
			})
		).rejects.toThrow('refused');
		expect(await rawFile()).toBe(before);
	});

	it('applies two changes made at once, one after the other', async () => {
		await Promise.all([
			updateSystemOneSettings(dir, (current) => ({ ...current, engine: 'jev-cloud' })),
			updateSystemOneSettings(dir, (current) => ({ ...current, timeoutMs: 800 })),
		]);
		expect(await readSystemOneSettings(dir)).toMatchObject({ engine: 'jev-cloud', timeoutMs: 800 });
	});

	it('drops a field it cannot use and keeps the rest', async () => {
		await fs.writeFile(
			stateFile(),
			JSON.stringify({
				engine: 'jev-cloud',
				timeoutMs: 'fast',
				keys: { 'jev-cloud': { sealed: 7 } },
			})
		);
		expect(await readSystemOneSettings(dir)).toEqual({
			...DEFAULT_SYSTEM_ONE_SETTINGS,
			engine: 'jev-cloud',
		});
		expect(await readSystemOneStoredKey(dir, 'jev-cloud', osSeal())).toEqual({ state: 'none' });
	});
});

describe('keys', () => {
	it('stores a key sealed by the OS, never as readable text, and opens it again', async () => {
		expect(await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal())).toBe('os');
		const raw = await rawFile();
		expect(raw).not.toContain(JEV_KEY);
		expect(JSON.parse(raw).keys['jev-cloud'].storage).toBe('os');
		expect(await readSystemOneStoredKey(dir, 'jev-cloud', osSeal())).toEqual({
			state: 'ok',
			key: JEV_KEY,
			storage: 'os',
		});
	});

	it('obscures a key where the OS offers no key store, and says so', async () => {
		expect(await storeSystemOneKey(dir, 'openjev', OPEN_KEY, osSeal(false))).toBe('obscured');
		expect(await rawFile()).not.toContain(OPEN_KEY);
		expect(await readSystemOneStoredKey(dir, 'openjev', osSeal(false))).toEqual({
			state: 'ok',
			key: OPEN_KEY,
			storage: 'obscured',
		});
	});

	it('keeps one key per engine, and replaces only the one it is asked to', async () => {
		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		await storeSystemOneKey(dir, 'openjev', OPEN_KEY, osSeal());
		await storeSystemOneKey(dir, 'jev-cloud', 'sk-jev-replacement', osSeal());

		expect(await readSystemOneStoredKey(dir, 'jev-cloud', osSeal())).toMatchObject({
			key: 'sk-jev-replacement',
		});
		expect(await readSystemOneStoredKey(dir, 'openjev', osSeal())).toMatchObject({ key: OPEN_KEY });
		expect(await rawFile()).not.toContain(JEV_KEY);
	});

	it('reports a key it cannot open, by kind, and leaves it in the file', async () => {
		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		const before = await rawFile();
		const reset: SealProvider = {
			...osSeal(),
			unseal: () => {
				throw new Error('The key store was reset.');
			},
		};

		expect(await readSystemOneStoredKey(dir, 'jev-cloud', reset)).toEqual({
			state: 'unreadable',
			storage: 'os',
			reason: 'unreadable',
		});
		expect(await readSystemOneStoredKey(dir, 'jev-cloud', osSeal(false))).toEqual({
			state: 'unreadable',
			storage: 'os',
			reason: 'store-unavailable',
		});
		expect(await rawFile()).toBe(before);
	});

	it('forgets a key, and says whether there was one', async () => {
		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		expect(await clearSystemOneKey(dir, 'jev-cloud')).toBe(true);
		expect(await clearSystemOneKey(dir, 'jev-cloud')).toBe(false);
		expect(await readSystemOneStoredKey(dir, 'jev-cloud', osSeal())).toEqual({ state: 'none' });
	});

	it('leaves the keys alone when the settings change, and the settings when a key does', async () => {
		await updateSystemOneSettings(dir, (current) => ({ ...current, engine: 'jev-cloud' }));
		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		await updateSystemOneSettings(dir, (current) => ({ ...current, timeoutMs: 700 }));

		expect(await readSystemOneStoredKey(dir, 'jev-cloud', osSeal())).toMatchObject({
			key: JEV_KEY,
		});
		expect(await readSystemOneSettings(dir)).toMatchObject({ engine: 'jev-cloud', timeoutMs: 700 });

		await clearSystemOneKey(dir, 'jev-cloud');
		expect(await readSystemOneSettings(dir)).toMatchObject({ engine: 'jev-cloud', timeoutMs: 700 });
	});

	it('never returns a key from a settings read', async () => {
		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		const settings = await readSystemOneSettings(dir);
		expect(settings).not.toHaveProperty('keys');
		expect(JSON.stringify(settings)).not.toContain('sealed');
	});

	it.skipIf(process.platform === 'win32')('keeps the file readable by its owner only', async () => {
		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		expect((await fs.stat(stateFile())).mode & 0o777).toBe(0o600);
	});
});

describe('the Test pass', () => {
	const jevPass: SystemOneTestPass = { engine: 'jev-cloud', signature: 'setup-a', at: 1_000 };
	const openPass: SystemOneTestPass = { engine: 'openjev', signature: 'setup-b', at: 2_000 };
	const stored = async () => (await readSystemOneSetup(dir)).testPass;

	it('is absent until a Test passes, and writes nothing to say so', async () => {
		expect(await readSystemOneSetup(dir)).toEqual({
			settings: DEFAULT_SYSTEM_ONE_SETTINGS,
			testPass: null,
		});
		await expect(fs.access(stateFile())).rejects.toThrow();
	});

	it('is stored, read back with the settings, and replaced by the next pass', async () => {
		await storeSystemOneTestPass(dir, jevPass);
		expect(await stored()).toEqual(jevPass);

		await storeSystemOneTestPass(dir, openPass);
		expect(await stored()).toEqual(openPass);
	});

	it('is not part of the settings, and survives a change to them', async () => {
		await storeSystemOneTestPass(dir, jevPass);

		const next = await updateSystemOneSettings(dir, (current) => ({ ...current, timeoutMs: 900 }));

		expect(next).not.toHaveProperty('testPass');
		expect(await readSystemOneSettings(dir)).not.toHaveProperty('testPass');
		expect(await stored()).toEqual(jevPass);
	});

	it("is dropped when that engine's key is stored or cleared, and kept for another engine's", async () => {
		await storeSystemOneTestPass(dir, jevPass);
		await storeSystemOneKey(dir, 'openjev', OPEN_KEY, osSeal());
		expect(await stored()).toEqual(jevPass);

		await storeSystemOneKey(dir, 'jev-cloud', JEV_KEY, osSeal());
		expect(await stored()).toBeNull();

		await storeSystemOneTestPass(dir, jevPass);
		await clearSystemOneKey(dir, 'openjev');
		expect(await stored()).toEqual(jevPass);
		await clearSystemOneKey(dir, 'jev-cloud');
		expect(await stored()).toBeNull();
	});

	it('is forgotten only for the engine whose Test failed, and says whether there was one', async () => {
		await storeSystemOneTestPass(dir, jevPass);

		expect(await clearSystemOneTestPass(dir, 'local-judge')).toBe(false);
		expect(await stored()).toEqual(jevPass);
		expect(await clearSystemOneTestPass(dir, 'jev-cloud')).toBe(true);
		expect(await stored()).toBeNull();
		expect(await clearSystemOneTestPass(dir, 'jev-cloud')).toBe(false);
	});

	it('reads a pass it cannot use as no pass', async () => {
		for (const testPass of [
			'yes',
			{ engine: 'gpt', signature: 's', at: 1 },
			{ engine: 'jev-cloud', signature: 7, at: 1 },
			{ engine: 'jev-cloud', signature: 's', at: 'today' },
			{ engine: 'off', signature: 's', at: 1 },
		]) {
			await fs.writeFile(stateFile(), JSON.stringify({ engine: 'jev-cloud', testPass }));
			expect(await stored()).toBeNull();
		}
	});
});
