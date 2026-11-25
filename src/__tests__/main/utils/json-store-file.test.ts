import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { createJsonStoreFile } from '../../../main/utils/json-store-file';
import { logger } from '../../../main/utils/logger';

interface Counter {
	count: number;
}

const parse = (value: unknown): Counter =>
	typeof (value as Counter | null)?.count === 'number' ? (value as Counter) : { count: 0 };

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-json-store-'));
	file = path.join(dir, 'nested', 'store.json');
	vi.clearAllMocks();
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

function store() {
	return createJsonStoreFile<Counter>({
		filePath: () => file,
		empty: () => ({ count: 0 }),
		parse,
		logContext: 'Test',
	});
}

describe('createJsonStoreFile', () => {
	it('starts empty, writes each change atomically (creating the folder), and reloads it', async () => {
		const counter = store();
		await expect(counter.read((value) => value.count)).resolves.toBe(0);
		await expect(
			counter.update((value) => ({ store: { count: value.count + 1 }, result: 'one' }))
		).resolves.toBe('one');
		expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ count: 1 });
		await expect(store().read((value) => value.count)).resolves.toBe(1);
	});

	it('leaves the file untouched when a change answers no store', async () => {
		const counter = store();
		await expect(counter.update(() => ({ store: null, result: 7 }))).resolves.toBe(7);
		await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	it('runs changes one at a time, so none is lost', async () => {
		const counter = store();
		await Promise.all(
			Array.from({ length: 20 }, () =>
				counter.update((value) => ({ store: { count: value.count + 1 }, result: undefined }))
			)
		);
		await expect(counter.read((value) => value.count)).resolves.toBe(20);
	});

	it('moves a file that is not JSON aside, and lets the store judge JSON of the wrong shape', async () => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, '{ torn');
		await expect(store().read((value) => value.count)).resolves.toBe(0);
		const names = await fs.readdir(path.dirname(file));
		expect(names.some((name) => /\.corrupt-.*\.json$/.test(name))).toBe(true);
		expect(logger.warn).toHaveBeenCalled();

		await fs.writeFile(file, '{"something": "else"}');
		await expect(store().read((value) => value.count)).resolves.toBe(0);
	});
});
