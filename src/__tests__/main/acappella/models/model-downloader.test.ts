/**
 * @file model-downloader.test.ts
 *
 * The downloader's contract in four properties:
 *
 *   - a resumed download CONTINUES from the `.part` rather than restarting,
 *   - a hash mismatch is rejected, the `.part` is deleted, and both hashes are
 *     reported,
 *   - cancel leaves nothing behind,
 *   - the final file only ever appears AFTER verification.
 *
 * The transport is injected, so nothing here touches the network. The catalog is
 * replaced with one tiny entry whose real SHA-256 is computed in the test, which
 * is the only way to exercise the success path without a 141 MB download.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const tempRoot = { dir: '' };

vi.mock('electron', () => ({
	app: { getPath: () => tempRoot.dir },
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const fixture = vi.hoisted(() => {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { createHash } = require('crypto') as typeof import('crypto');
	const contents = Buffer.from('a cappella downloader fixture payload, long enough to slice');
	return {
		contents,
		id: 'test-tiny-model',
		url: 'https://example.invalid/tiny.bin',
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
				sourceUrl: fixture.url,
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
	ModelDownloader,
	type DownloadProgress,
	type FetchLike,
} from '../../../../main/acappella/models/model-downloader';
import {
	modelDir,
	modelFilePath,
	readManifest,
} from '../../../../main/acappella/models/model-store';

const FILE_PATH = 'tiny.bin';

function finalPath(): string {
	return modelFilePath(fixture.id, FILE_PATH);
}

function partPath(): string {
	return `${finalPath()}.part`;
}

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/** A fetch that serves `body` and honours `Range: bytes=N-`. */
function rangeAwareFetch(
	body: Buffer,
	record: { ranges: string[] } = { ranges: [] }
): { fetchImpl: FetchLike; record: { ranges: string[] } } {
	const fetchImpl: FetchLike = async (_url, init) => {
		const range = (init?.headers as Record<string, string> | undefined)?.Range;
		record.ranges.push(range ?? '');
		if (!range) return new Response(new Uint8Array(body), { status: 200 });
		const start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
		return new Response(new Uint8Array(body.subarray(start)), { status: 206 });
	};
	return { fetchImpl, record };
}

function makeDownloader(fetchImpl: FetchLike): ModelDownloader {
	return new ModelDownloader({ fetchImpl, retryDelayMs: () => 0, progressIntervalMs: 0 });
}

describe('model-downloader', () => {
	let previousUserData: string | undefined;

	beforeEach(async () => {
		tempRoot.dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-downloader-'));
		// MAESTRO_USER_DATA wins over the electron mock in `dataDir()`, and a
		// Maestro-run agent has it pointed at the live install.
		previousUserData = process.env.MAESTRO_USER_DATA;
		process.env.MAESTRO_USER_DATA = tempRoot.dir;
	});

	afterEach(async () => {
		if (previousUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = previousUserData;
		await fs.rm(tempRoot.dir, { recursive: true, force: true });
	});

	it('downloads, verifies, and only then renames into place', async () => {
		const seenDuringTransfer: boolean[] = [];
		const fetchImpl: FetchLike = async () => {
			// The final path must not exist while bytes are still arriving.
			seenDuringTransfer.push(await exists(finalPath()));
			return new Response(new Uint8Array(fixture.contents), { status: 200 });
		};

		const downloader = makeDownloader(fetchImpl);
		const result = await downloader.download(fixture.id);

		expect(result.status).toBe('complete');
		expect(seenDuringTransfer).toEqual([false]);
		expect(await exists(finalPath())).toBe(true);
		expect(await exists(partPath())).toBe(false);

		const manifest = await readManifest(fixture.id);
		expect(manifest?.id).toBe(fixture.id);
		expect(manifest?.bytes).toBe(fixture.bytes);
	});

	it('resumes from a partial .part instead of restarting', async () => {
		const { fetchImpl, record } = rangeAwareFetch(fixture.contents);

		// Simulate a killed app: the first 20 bytes are already on disk.
		await fs.mkdir(modelDir(fixture.id), { recursive: true });
		await fs.writeFile(partPath(), fixture.contents.subarray(0, 20));

		const downloader = makeDownloader(fetchImpl);
		const result = await downloader.download(fixture.id);

		expect(result.status).toBe('complete');
		expect(record.ranges).toEqual(['bytes=20-']);
		// The digest has to cover the resumed bytes too, or the completed file
		// would fail verification despite being byte-perfect.
		expect(await fs.readFile(finalPath())).toEqual(fixture.contents);
	});

	it('restarts when the server ignores the range header', async () => {
		const requests: string[] = [];
		const fetchImpl: FetchLike = async (_url, init) => {
			requests.push((init?.headers as Record<string, string> | undefined)?.Range ?? '');
			// 200, not 206: the whole file, despite the range request.
			return new Response(new Uint8Array(fixture.contents), { status: 200 });
		};

		await fs.mkdir(modelDir(fixture.id), { recursive: true });
		await fs.writeFile(partPath(), fixture.contents.subarray(0, 20));

		const result = await makeDownloader(fetchImpl).download(fixture.id);

		expect(requests).toEqual(['bytes=20-']);
		expect(result.status).toBe('complete');
		// Appending onto the stale partial would have produced 20 extra bytes.
		expect(await fs.readFile(finalPath())).toEqual(fixture.contents);
	});

	it('rejects a hash mismatch, deletes the .part, and reports both hashes', async () => {
		const corrupted = Buffer.from(fixture.contents);
		corrupted[0] = corrupted[0] ^ 0xff;
		const fetchImpl: FetchLike = async () =>
			new Response(new Uint8Array(corrupted), { status: 200 });

		const downloader = makeDownloader(fetchImpl);
		const progress: DownloadProgress[] = [];
		downloader.onProgress((event) => progress.push(event));

		const result = await downloader.download(fixture.id);

		expect(result.status).toBe('error');
		expect(result.mismatch?.expected).toBe(fixture.sha256);
		expect(result.mismatch?.actual).not.toBe(fixture.sha256);
		// Nothing verified, so nothing may be at the final path, and the bad bytes
		// must not survive to be "resumed" forever.
		expect(await exists(finalPath())).toBe(false);
		expect(await exists(partPath())).toBe(false);
		expect(await readManifest(fixture.id)).toBeNull();
		expect(progress.at(-1)?.phase).toBe('error');
	});

	it('cancel leaves no stray files', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});

		const fetchImpl: FetchLike = async () => {
			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(new Uint8Array(fixture.contents.subarray(0, 10)));
					await gate;
					controller.close();
				},
			});
			return new Response(stream, { status: 200 });
		};

		const downloader = makeDownloader(fetchImpl);
		const running = downloader.download(fixture.id);
		// Let the first chunk land so there is something on disk to clean up.
		await new Promise((resolve) => setTimeout(resolve, 20));

		const cancelPromise = downloader.cancel(fixture.id);
		release();
		await cancelPromise;
		const result = await running;

		expect(result.status).toBe('cancelled');
		expect(await exists(partPath())).toBe(false);
		expect(await exists(finalPath())).toBe(false);
		expect(await exists(modelDir(fixture.id))).toBe(false);
	});

	it('pause keeps the partial file so the next start resumes', async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let served = 0;

		const fetchImpl: FetchLike = async (_url, init) => {
			served++;
			const range = (init?.headers as Record<string, string> | undefined)?.Range;
			if (served === 1) {
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(new Uint8Array(fixture.contents.subarray(0, 12)));
						await gate;
						controller.close();
					},
				});
				return new Response(stream, { status: 200 });
			}
			const start = Number(/bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
			return new Response(new Uint8Array(fixture.contents.subarray(start)), { status: 206 });
		};

		const downloader = makeDownloader(fetchImpl);
		const running = downloader.download(fixture.id);
		await new Promise((resolve) => setTimeout(resolve, 20));

		expect(downloader.pause(fixture.id)).toBe(true);
		release();
		const paused = await running;

		expect(paused.status).toBe('paused');
		expect(await exists(partPath())).toBe(true);
		expect(await exists(finalPath())).toBe(false);

		const resumed = await downloader.resume(fixture.id);
		expect(resumed.status).toBe('complete');
		expect(await fs.readFile(finalPath())).toEqual(fixture.contents);
	});

	it('retries a transient server error and then succeeds', async () => {
		let attempts = 0;
		const fetchImpl: FetchLike = async () => {
			attempts++;
			if (attempts < 3) return new Response('boom', { status: 503 });
			return new Response(new Uint8Array(fixture.contents), { status: 200 });
		};

		const result = await makeDownloader(fetchImpl).download(fixture.id);
		expect(result.status).toBe('complete');
		expect(attempts).toBe(3);
	});

	it('does not retry a 404', async () => {
		let attempts = 0;
		const fetchImpl: FetchLike = async () => {
			attempts++;
			return new Response('nope', { status: 404 });
		};

		const result = await makeDownloader(fetchImpl).download(fixture.id);
		expect(result.status).toBe('error');
		expect(result.error).toContain('404');
		expect(attempts).toBe(1);
	});

	it('rejects an unknown model without touching the transport', async () => {
		const fetchImpl = vi.fn<FetchLike>();
		const result = await makeDownloader(fetchImpl).download('not-a-model');
		expect(result.status).toBe('error');
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('reports bytes, total, and a rate on progress', async () => {
		const fetchImpl: FetchLike = async () =>
			new Response(new Uint8Array(fixture.contents), { status: 200 });

		const downloader = makeDownloader(fetchImpl);
		const events: DownloadProgress[] = [];
		downloader.onProgress((event) => events.push(event));

		await downloader.download(fixture.id);

		expect(events.length).toBeGreaterThan(0);
		expect(events.every((event) => event.bytesTotal === fixture.bytes)).toBe(true);
		expect(events.at(-1)?.phase).toBe('complete');
		expect(events.at(-1)?.bytesReceived).toBe(fixture.bytes);
	});
});
