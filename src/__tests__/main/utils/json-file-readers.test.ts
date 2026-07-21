import * as fs from 'fs/promises';
import * as os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	readKeyedJsonArray,
	readVersionedJsonCache,
	type VersionedJson,
} from '../../../main/utils/json-file-readers';

interface TestCache extends VersionedJson {
	payload?: string;
}

interface TestEntry extends VersionedJson {
	id: string;
}

function hasVersion(value: unknown): value is { version: unknown } {
	return typeof value === 'object' && value !== null && 'version' in value;
}

const isTestCache = (value: unknown): value is TestCache =>
	hasVersion(value) && typeof value.version === 'number';

const isTestEntry = (value: unknown): value is TestEntry =>
	hasVersion(value) &&
	'id' in value &&
	typeof value.id === 'string' &&
	typeof value.version === 'number';

const tempDirectories: string[] = [];

async function fixturePath(filename: string): Promise<string> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-json-reader-'));
	tempDirectories.push(directory);
	return path.join(directory, filename);
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true }))
	);
});

describe('readVersionedJsonCache', () => {
	it('returns a current cache from a real filesystem fixture', async () => {
		const filePath = await fixturePath('current.json');
		await fs.writeFile(filePath, JSON.stringify({ version: 3, payload: 'current' }));

		await expect(readVersionedJsonCache(filePath, 3, isTestCache)).resolves.toEqual({
			version: 3,
			payload: 'current',
		});
	});

	it.each([
		['missing', undefined],
		['old version', JSON.stringify({ version: 2 })],
		['new version', JSON.stringify({ version: 4 })],
		['malformed', '{"version":'],
		['partial', '{"version": 3'],
	])('returns a safe miss for a %s cache fixture', async (_name, contents) => {
		const filePath = await fixturePath('cache.json');
		if (contents !== undefined) await fs.writeFile(filePath, contents);

		await expect(readVersionedJsonCache(filePath, 3, isTestCache)).resolves.toBeNull();
	});

	it('returns a safe miss when the cache path cannot be read as a file', async () => {
		const directoryPath = await fixturePath('unreadable.json');
		await fs.mkdir(directoryPath);

		await expect(readVersionedJsonCache(directoryPath, 3, isTestCache)).resolves.toBeNull();
	});
});

describe('readKeyedJsonArray', () => {
	it('returns a valid mixed-version keyed array from a real filesystem fixture', async () => {
		const filePath = await fixturePath('entries.json');
		await fs.writeFile(
			filePath,
			JSON.stringify({
				entries: [
					{ id: 'legacy', version: 1 },
					{ id: 'current', version: 2 },
				],
			})
		);

		await expect(readKeyedJsonArray(filePath, 'entries', isTestEntry)).resolves.toEqual([
			{ id: 'legacy', version: 1 },
			{ id: 'current', version: 2 },
		]);
	});

	it.each([
		['wrong root', JSON.stringify([])],
		['missing key', JSON.stringify({})],
		['non-array key', JSON.stringify({ entries: {} })],
		[
			'invalid element',
			JSON.stringify({
				entries: [
					{ id: 'valid', version: 1 },
					{ id: 2, version: 1 },
				],
			}),
		],
		['malformed JSON', '{"entries":'],
	])('returns a safe miss for a %s keyed-array fixture', async (_name, contents) => {
		const filePath = await fixturePath('entries.json');
		await fs.writeFile(filePath, contents);

		await expect(readKeyedJsonArray(filePath, 'entries', isTestEntry)).resolves.toBeNull();
	});
});
