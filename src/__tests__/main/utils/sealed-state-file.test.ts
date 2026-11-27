/**
 * @file sealed-state-file.test.ts
 *
 * The two pieces every per-device store with a secret is built on. Properties
 * worth protecting:
 *
 *   - **A secret is never readable text**: sealed by the OS where it has a key
 *     store, obscured where it has none, and the record says which.
 *   - **A secret that will not open is refused, by kind**, and nothing guesses.
 *   - **A file that is not JSON is moved aside**, never written over.
 *   - **Changes run one at a time**, and the file is readable by its owner only.
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
vi.mock('../../../main/utils/logger', () => ({ logger }));
vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import type { SealProvider } from '../../../main/utils/safe-storage-seal';
import {
	SealedSecretError,
	createPrivateStateFile,
	isSealedSecretError,
	isStoredSecret,
	sealSecret,
	unsealSecret,
} from '../../../main/utils/sealed-state-file';

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

const SECRET = 'sk-test-0123456789abcdef';

describe('sealSecret and unsealSecret', () => {
	it('seals with the OS key store when it has one, and opens again', () => {
		const stored = sealSecret(SECRET, osSeal());
		expect(stored.storage).toBe('os');
		expect(Buffer.from(stored.sealed, 'base64').toString()).not.toContain(SECRET);
		expect(isStoredSecret(stored)).toBe(true);
		expect(unsealSecret(stored, osSeal())).toBe(SECRET);
	});

	it('obscures where the OS offers no key store, and still never writes readable text', () => {
		const stored = sealSecret(SECRET, osSeal(false));
		expect(stored.storage).toBe('obscured');
		expect(Buffer.from(stored.sealed, 'base64').toString('latin1')).not.toContain(SECRET);
		// An obscured secret opens with no OS seal at all.
		expect(unsealSecret(stored, osSeal(false))).toBe(SECRET);
		expect(unsealSecret(stored, osSeal())).toBe(SECRET);
	});

	it('refuses an OS-sealed secret when the key store is gone, and says that is why', () => {
		const stored = sealSecret(SECRET, osSeal());
		const error = (() => {
			try {
				unsealSecret(stored, osSeal(false));
			} catch (caught) {
				return caught;
			}
		})();
		expect(isSealedSecretError(error)).toBe(true);
		expect((error as SealedSecretError).kind).toBe('store-unavailable');
	});

	it('refuses a secret that does not open under the seal', () => {
		const stored = sealSecret(SECRET, osSeal());
		const reset: SealProvider = {
			...osSeal(),
			unseal: () => {
				throw new Error('The key store was reset.');
			},
		};
		expect(() => unsealSecret(stored, reset)).toThrow(SealedSecretError);
		try {
			unsealSecret(stored, reset);
		} catch (error) {
			expect((error as SealedSecretError).kind).toBe('unreadable');
			// The reason a seal gives is kept as the cause, never as the message.
			expect((error as SealedSecretError).message).not.toContain('reset');
		}
		// An obscured record that was edited by hand does not open either.
		const obscured = sealSecret(SECRET, osSeal(false));
		const edited = { ...obscured, sealed: Buffer.from('tampered-bytes-here').toString('base64') };
		expect(() => unsealSecret(edited, osSeal(false))).toThrow(SealedSecretError);
	});

	it('reports a seal that throws as seal-failed', () => {
		const broken: SealProvider = {
			...osSeal(),
			seal: () => {
				throw new Error('keychain locked');
			},
		};
		try {
			sealSecret(SECRET, broken);
			expect.unreachable();
		} catch (error) {
			expect((error as SealedSecretError).kind).toBe('seal-failed');
			expect((error as SealedSecretError).message).toContain('keychain locked');
		}
	});

	it('tells a stored secret from anything else', () => {
		expect(isStoredSecret({ sealed: 'abc', storage: 'os' })).toBe(true);
		expect(isStoredSecret({ sealed: '', storage: 'os' })).toBe(false);
		expect(isStoredSecret({ sealed: 'abc', storage: 'plain' })).toBe(false);
		expect(isStoredSecret({ sealed: 7, storage: 'os' })).toBe(false);
		expect(isStoredSecret(null)).toBe(false);
	});
});

describe('createPrivateStateFile', () => {
	interface State {
		count: number;
	}

	const file = createPrivateStateFile<State>({
		fileName: 'thing.json',
		normalize: (parsed) => {
			const count = (parsed as { count?: unknown } | null)?.count;
			return { count: typeof count === 'number' ? count : 0 };
		},
		logContext: 'Test',
		whenCorrupt: 'the count starts at zero',
	});

	let dir: string;

	beforeEach(async () => {
		vi.clearAllMocks();
		dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sealed-state-file-'));
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it('reads the normalized empty state, and writes nothing, when there is no file', async () => {
		expect(await file.read(dir)).toEqual({ count: 0 });
		await expect(fs.access(file.path(dir))).rejects.toThrow();
	});

	it('saves what a change asks for, and leaves the file alone when it asks for nothing', async () => {
		expect(
			await file.update(dir, async (state, save) => {
				await save({ count: state.count + 1 });
				return 'saved';
			})
		).toBe('saved');
		expect(await file.read(dir)).toEqual({ count: 1 });

		const before = await fs.readFile(file.path(dir), 'utf-8');
		await file.update(dir, async () => undefined);
		expect(await fs.readFile(file.path(dir), 'utf-8')).toBe(before);
	});

	it('runs changes one at a time, so none is lost', async () => {
		await Promise.all(
			Array.from({ length: 12 }, () =>
				file.update(dir, async (state, save) => save({ count: state.count + 1 }))
			)
		);
		expect(await file.read(dir)).toEqual({ count: 12 });
	});

	it('moves a file that is not JSON aside rather than losing it, and says what that cost', async () => {
		await fs.writeFile(file.path(dir), '{"count": 4, ');
		expect(await file.read(dir)).toEqual({ count: 0 });

		const files = await fs.readdir(dir);
		const sidecar = files.find((name) => /^thing\.corrupt-.+\.json$/.test(name));
		expect(sidecar).toBeDefined();
		expect(await fs.readFile(path.join(dir, sidecar!), 'utf-8')).toBe('{"count": 4, ');
		expect(files).not.toContain('thing.json');
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('the count starts at zero'),
			'Test'
		);
	});

	it('creates the data folder when it is missing', async () => {
		const nested = path.join(dir, 'not', 'made', 'yet');
		await file.update(nested, async (_state, save) => save({ count: 3 }));
		expect(await file.read(nested)).toEqual({ count: 3 });
	});

	it.skipIf(process.platform === 'win32')('keeps the file readable by its owner only', async () => {
		await file.update(dir, async (_state, save) => save({ count: 1 }));
		expect((await fs.stat(file.path(dir))).mode & 0o777).toBe(0o600);
	});
});
