/**
 * @file model-store.test.ts
 *
 * The store's job is to be pessimistic about disk. These tests pin the four
 * properties the rest of the subsystem trusts:
 *
 *   - a manifest round-trips,
 *   - `isInstalled` REJECTS a truncated file (the whole reason it is not an
 *     `existsSync`),
 *   - concurrent manifest writers never produce a half-written file,
 *   - `remove` reclaims the entire directory, partials included.
 *
 * Runs against a real temp directory: the failure mode being tested is a
 * property of the filesystem, so mocking `fs` would test the mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tempRoot = { dir: '' };

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

/**
 * A synthetic catalog entry small enough to actually satisfy.
 *
 * The real catalog's hashes belong to files of 2 MB to 1 GB, so the SUCCESS path
 * of `verify()` cannot be exercised against them without a download. Appending
 * one tiny entry (real bytes, real hash, computed here) is what makes "verify
 * passes and stamps verifiedAt" testable at all. Every other test still runs
 * against the genuine catalog entries.
 */
const fixture = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { createHash } = require('crypto') as typeof import('crypto');
	const contents = Buffer.from('a cappella test model payload');
	return {
		contents,
		id: 'test-tiny-model',
		sha256: createHash('sha256').update(contents).digest('hex'),
		bytes: contents.length,
	};
});

vi.mock('../../../../shared/acappella/model-catalog', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../shared/acappella/model-catalog')>();
	const testEntry = Object.freeze({
		id: fixture.id,
		displayName: 'Test Tiny Model',
		role: 'stt' as const,
		repo: 'maestro/test',
		revision: '0000000000000000000000000000000000000000',
		license: 'MIT',
		licenseUrl: 'https://example.invalid/license',
		requiredFor: 'local-speech-to-text' as const,
		description: 'Fixture entry, present only under test.',
		files: Object.freeze([
			{
				path: 'tiny.bin',
				sourceUrl: 'https://example.invalid/tiny.bin',
				sha256: fixture.sha256,
				bytes: fixture.bytes,
			},
		]),
		bytes: fixture.bytes,
	});
	const catalog = Object.freeze([...actual.VOICE_MODEL_CATALOG, testEntry]);
	const byId = new Map(catalog.map((entry) => [entry.id, entry]));
	return {
		...actual,
		VOICE_MODEL_CATALOG: catalog,
		getVoiceModel: (id: string) => byId.get(id),
		isVoiceModelId: (id: string) => byId.has(id),
	};
});

import {
	buildManifest,
	getStatus,
	isInstalled,
	markInstalled,
	modelDigest,
	modelDir,
	modelFilePath,
	readManifest,
	remove,
	removeAll,
	totalFootprint,
	verify,
	writeManifest,
} from '../../../../main/acappella/models/model-store';
import {
	OPENWAKEWORD_BASE_ID,
	WHISPER_BASE_EN_ID,
	getVoiceModel,
} from '../../../../shared/acappella/model-catalog';

const whisper = getVoiceModel(WHISPER_BASE_EN_ID)!;
const wakeWord = getVoiceModel(OPENWAKEWORD_BASE_ID)!;

/**
 * Write files matching the catalog's declared lengths.
 *
 * The bytes are zeros, so the LENGTH is right and the HASH is not. That is
 * deliberate: it is exactly the state a truncated-then-padded file would be in,
 * and it lets the length check and the hash check be tested independently.
 */
async function writeFilesOfDeclaredLength(id: string, entry = getVoiceModel(id)!): Promise<void> {
	for (const file of entry.files) {
		const full = modelFilePath(id, file.path);
		await fs.mkdir(path.dirname(full), { recursive: true });
		await fs.writeFile(full, Buffer.alloc(file.bytes));
	}
}

/** Same, but with a real payload whose hash we control. */
async function writeFileWithContents(
	id: string,
	filePath: string,
	contents: Buffer
): Promise<void> {
	const full = modelFilePath(id, filePath);
	await fs.mkdir(path.dirname(full), { recursive: true });
	await fs.writeFile(full, contents);
}

describe('model-store', () => {
	let previousUserData: string | undefined;

	beforeEach(async () => {
		tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-models-'));
		// `dataDir()` checks MAESTRO_USER_DATA BEFORE app.getPath, and a Maestro-run
		// agent has that variable set to the real user-data directory. Without this
		// override the electron mock is bypassed entirely and these tests write to
		// (and delete from) the live install.
		previousUserData = process.env.MAESTRO_USER_DATA;
		process.env.MAESTRO_USER_DATA = tempRoot.dir;
	});

	afterEach(async () => {
		if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = previousUserData;
		await fs.rm(tempRoot.dir, { recursive: true, force: true });
	});

	describe('manifest round-trip', () => {
		it('writes and reads back every recorded field', async () => {
			const manifest = buildManifest(wakeWord, 1_700_000_000_000);
			await writeManifest(manifest);

			const read = await readManifest(wakeWord.id);
			expect(read).toEqual(manifest);
			expect(read?.revision).toBe(wakeWord.revision);
			expect(read?.license).toBe(wakeWord.license);
			expect(read?.installedAt).toBe(1_700_000_000_000);
			expect(read?.verifiedAt).toBe(1_700_000_000_000);
			expect(read?.files).toHaveLength(wakeWord.files.length);
		});

		it('reads an absent manifest as null rather than throwing', async () => {
			expect(await readManifest(whisper.id)).toBeNull();
		});

		it('reads an unparseable manifest as null, not as an install', async () => {
			await fs.mkdir(modelDir(whisper.id), { recursive: true });
			await fs.writeFile(path.join(modelDir(whisper.id), 'manifest.json'), '{ truncated');

			expect(await readManifest(whisper.id)).toBeNull();
			expect(await isInstalled(whisper.id)).toBe(false);
		});
	});

	describe('isInstalled', () => {
		it('rejects a truncated file even though the file exists', async () => {
			await markInstalled(wakeWord);
			await writeFilesOfDeclaredLength(wakeWord.id);
			expect(await isInstalled(wakeWord.id)).toBe(true);

			// Chop one byte off. `existsSync` would still say yes; this must not.
			const victim = modelFilePath(wakeWord.id, wakeWord.files[0].path);
			await fs.truncate(victim, wakeWord.files[0].bytes - 1);

			expect(await isInstalled(wakeWord.id)).toBe(false);
			const status = await getStatus(wakeWord.id);
			expect(status.status).toBe('corrupt');
			expect(status.detail).toContain(wakeWord.files[0].path);
		});

		it('rejects a manifest with no files on disk', async () => {
			await markInstalled(wakeWord);
			expect(await isInstalled(wakeWord.id)).toBe(false);
			expect((await getStatus(wakeWord.id)).detail).toContain('Missing file');
		});

		it('rejects files on disk with no manifest', async () => {
			await writeFilesOfDeclaredLength(wakeWord.id);
			const status = await getStatus(wakeWord.id);
			expect(status.status).toBe('not-installed');
			expect(status.detail).toContain('no manifest');
		});

		it('reports an install from a superseded catalog revision as not installed', async () => {
			await writeFilesOfDeclaredLength(wakeWord.id);
			await writeManifest({
				...buildManifest(wakeWord, Date.now()),
				revision: 'deadbeef',
				sha256: modelDigest([{ path: 'stale', sha256: 'stale' }]),
			});

			const status = await getStatus(wakeWord.id);
			expect(status.status).toBe('not-installed');
			expect(status.detail).toContain('no longer matches the catalog');
		});
	});

	describe('atomic manifest writes under concurrent callers', () => {
		it('never leaves a partially written manifest', async () => {
			const writes = Array.from({ length: 25 }, (_, index) =>
				writeManifest({ ...buildManifest(wakeWord, 1_000 + index), verifiedAt: 2_000 + index })
			);
			await Promise.all(writes);

			// Every interleaving has to produce ONE whole manifest, not a concatenated
			// or truncated one. Parsing it is the assertion.
			const read = await readManifest(wakeWord.id);
			expect(read).not.toBeNull();
			expect(read?.id).toBe(wakeWord.id);
			expect(read?.files).toHaveLength(wakeWord.files.length);

			// And no temp file survives the race.
			const entries = await fs.readdir(modelDir(wakeWord.id));
			expect(entries.filter((name) => name.endsWith('.tmp'))).toHaveLength(0);
		});
	});

	describe('verify', () => {
		it('reports a hash mismatch as corrupt and repairs nothing', async () => {
			await markInstalled(wakeWord);
			await writeFilesOfDeclaredLength(wakeWord.id);

			const result = await verify(wakeWord.id);
			expect(result.ok).toBe(false);
			expect(result.status).toBe('corrupt');
			expect(result.mismatch?.expected).toBe(wakeWord.files[0].sha256);
			expect(result.mismatch?.actual).not.toBe(wakeWord.files[0].sha256);

			// The files are still exactly where they were: no silent delete, no
			// silent re-download.
			const size = (await fs.stat(modelFilePath(wakeWord.id, wakeWord.files[0].path))).size;
			expect(size).toBe(wakeWord.files[0].bytes);
		});

		it('stamps verifiedAt when every hash matches', async () => {
			const tiny = getVoiceModel(fixture.id)!;
			await writeFileWithContents(tiny.id, tiny.files[0].path, fixture.contents);
			const installed = await markInstalled(tiny);

			const result = await verify(tiny.id);
			expect(result.ok).toBe(true);
			expect(result.status).toBe('installed');
			expect(result.verifiedAt).toBeGreaterThanOrEqual(installed.installedAt);

			const manifest = await readManifest(tiny.id);
			expect(manifest?.verifiedAt).toBe(result.verifiedAt);
			expect(manifest?.installedAt).toBe(installed.installedAt);
		});

		it('reports an uninstalled model without hashing anything', async () => {
			const result = await verify(whisper.id);
			expect(result.ok).toBe(false);
			expect(result.status).toBe('not-installed');
		});
	});

	describe('remove and footprint', () => {
		it('reclaims the whole directory including stray partials', async () => {
			await markInstalled(wakeWord);
			await writeFilesOfDeclaredLength(wakeWord.id);
			await fs.writeFile(
				`${modelFilePath(wakeWord.id, wakeWord.files[0].path)}.part`,
				Buffer.alloc(4096)
			);

			const before = await totalFootprint();
			expect(before.bytes).toBeGreaterThan(wakeWord.bytes);

			const reclaimed = await remove(wakeWord.id);
			expect(reclaimed).toBe(before.bytes);
			await expect(fs.stat(modelDir(wakeWord.id))).rejects.toThrow();
			expect((await totalFootprint()).bytes).toBe(0);
		});

		it('counts directories that are no longer in the catalog', async () => {
			const orphan = path.join(tempRoot.dir, 'models', 'acappella', 'retired-model');
			await fs.mkdir(orphan, { recursive: true });
			await fs.writeFile(path.join(orphan, 'weights.bin'), Buffer.alloc(2048));

			const footprint = await totalFootprint();
			expect(footprint.bytes).toBe(2048);
			expect(footprint.models.map((model) => model.id)).toContain('retired-model');
		});

		it('removeAll leaves nothing behind: installed, half-downloaded, or orphaned', async () => {
			// The reclaim-disk promise in Settings, in one test. A user who switches
			// the Encore Feature off and accepts the offer is told a number of bytes;
			// anything this misses is disk they were told they got back and did not.
			await writeFilesOfDeclaredLength(wakeWord.id);
			await writeFilesOfDeclaredLength(whisper.id);
			// A download that was paused or interrupted. The bytes are real and they
			// are not inside any manifest.
			await fs.writeFile(
				`${modelFilePath(whisper.id, whisper.files[0].path)}.part`,
				Buffer.alloc(4096)
			);
			// A directory left by a model the catalog has since dropped. Disk the user
			// cannot see is disk they cannot get back.
			const orphan = path.join(tempRoot.dir, 'models', 'acappella', 'retired-model');
			await fs.mkdir(orphan, { recursive: true });
			await fs.writeFile(path.join(orphan, 'weights.bin'), Buffer.alloc(2048));

			const expected = (await totalFootprint()).bytes;
			expect(expected).toBe(wakeWord.bytes + whisper.bytes + 4096 + 2048);

			const reclaimed = await removeAll();

			expect(reclaimed).toBe(expected);
			expect(await totalFootprint()).toEqual({ bytes: 0, models: [] });
		});

		it('removeAll deletes only the A Cappella root', async () => {
			await writeFilesOfDeclaredLength(wakeWord.id);
			const neighbour = path.join(tempRoot.dir, 'plugins');
			await fs.mkdir(neighbour, { recursive: true });
			await fs.writeFile(path.join(neighbour, 'keep.json'), '{}');

			const reclaimed = await removeAll();
			expect(reclaimed).toBe(wakeWord.bytes);
			await expect(fs.stat(path.join(neighbour, 'keep.json'))).resolves.toBeTruthy();
		});
	});

	describe('path safety', () => {
		it('refuses an id that is not in the catalog', () => {
			expect(() => modelDir('../../etc')).toThrow(/UnknownVoiceModel/);
		});

		it('refuses a file path that escapes the model directory', () => {
			expect(() => modelFilePath(wakeWord.id, '../../escape.bin')).toThrow(/UnsafeModelFilePath/);
		});
	});
});
