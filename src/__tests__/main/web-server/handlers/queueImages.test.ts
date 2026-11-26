/**
 * `withQueueImages`: a queue snapshot's images for the client that reads it. A Federation client
 * asks for them, so a hosted queued card draws the thumbnails a local card draws; any other reader
 * (`maestro-cli queue list`) gets the items without them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { withQueueImages } from '../../../../main/web-server/handlers/messageHandlers/queue';
import {
	configureImageStore,
	storeInlineImage,
	__resetImageStoreCacheForTests,
} from '../../../../main/storage/session-image-store';
import type { QueueSessionSnapshot } from '../../../../main/web-server/types';

const dataUrl = (payload: string) =>
	`data:image/png;base64,${Buffer.from(payload).toString('base64')}`;
const MISSING_REF = `maestro-image://store/${'0'.repeat(64)}.png`;

function snapshot(images?: string[]): QueueSessionSnapshot[] {
	return [
		{
			sessionId: 's1',
			name: 'Agent',
			state: 'busy',
			items: [
				{ id: 'q1', timestamp: 1, tabId: 't', type: 'message', text: 'a', images },
				{ id: 'q2', timestamp: 2, tabId: 't', type: 'message', text: 'b' },
			],
		},
	];
}

describe('withQueueImages', () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-queue-images-'));
		configureImageStore(tmpDir);
	});

	afterEach(() => {
		__resetImageStoreCacheForTests();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('inlines each store ref as its data URL and drops a ref whose file is gone', async () => {
		const pasted = dataUrl('pasted');
		const stored = dataUrl('stored');
		const ref = await storeInlineImage(stored);
		expect(ref.startsWith('maestro-image://')).toBe(true);

		const [queue] = await withQueueImages(snapshot([pasted, ref, MISSING_REF]), true);
		expect(queue.items[0].images).toEqual([pasted, stored]);
		expect(queue.items[1]).not.toHaveProperty('images');
	});

	it('leaves out an item whose images all failed to resolve', async () => {
		const [queue] = await withQueueImages(snapshot([MISSING_REF]), true);
		expect(queue.items[0]).not.toHaveProperty('images');
	});

	it('gives a reader that did not ask the items without their images', async () => {
		const [queue] = await withQueueImages(snapshot([dataUrl('pasted')]), false);
		expect(queue.items[0]).not.toHaveProperty('images');
		expect(queue.items[0]).toMatchObject({ id: 'q1', text: 'a' });
	});
});
