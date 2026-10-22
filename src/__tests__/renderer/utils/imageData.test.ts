/**
 * imageData - reading pasted and dropped images, and shrinking them for a preview.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../renderer/utils/loadImage', () => ({ loadImageElement: vi.fn() }));
import { loadImageElement } from '../../../renderer/utils/loadImage';
import {
	downscaleImageDataUrl,
	imageFilesIn,
	readBlobAsDataUrl,
} from '../../../renderer/utils/imageData';

function file(name: string, type: string): File {
	return new File(['bytes'], name, { type });
}

function sized(width: number, height: number): HTMLImageElement {
	return { naturalWidth: width, naturalHeight: height } as HTMLImageElement;
}

afterEach(() => vi.restoreAllMocks());

describe('readBlobAsDataUrl', () => {
	it('reads a blob as a data URL', async () => {
		const url = await readBlobAsDataUrl(new Blob(['hi'], { type: 'image/png' }));
		expect(url).toBe(`data:image/png;base64,${btoa('hi')}`);
	});
});

describe('imageFilesIn', () => {
	it('takes the image items of a paste, in order, and skips the rest', () => {
		const a = file('a.png', 'image/png');
		const b = file('b.jpg', 'image/jpeg');
		const transfer = {
			items: [
				{ kind: 'string', type: 'text/plain', getAsFile: () => null },
				{ kind: 'file', type: 'image/png', getAsFile: () => a },
				{
					kind: 'file',
					type: 'application/pdf',
					getAsFile: () => file('c.pdf', 'application/pdf'),
				},
				{ kind: 'file', type: 'image/jpeg', getAsFile: () => b },
			],
			files: [],
		} as unknown as DataTransfer;
		expect(imageFilesIn(transfer)).toEqual([a, b]);
	});

	it('falls back to the files of a drop with no items', () => {
		const a = file('a.webp', 'image/webp');
		const transfer = { files: [file('notes.txt', 'text/plain'), a] } as unknown as DataTransfer;
		expect(imageFilesIn(transfer)).toEqual([a]);
	});

	it('finds nothing in no transfer', () => {
		expect(imageFilesIn(null)).toEqual([]);
	});
});

describe('downscaleImageDataUrl', () => {
	const src = 'data:image/png;base64,AAAA';

	it('returns an image already within the size as it was', async () => {
		vi.mocked(loadImageElement).mockResolvedValue(sized(300, 200));
		await expect(downscaleImageDataUrl(src, 320)).resolves.toBe(src);
	});

	it('draws a larger image down to the size on its longer edge', async () => {
		vi.mocked(loadImageElement).mockResolvedValue(sized(1600, 800));
		const drawImage = vi.fn();
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({ drawImage }),
			toDataURL: vi.fn(() => 'data:image/webp;base64,SMALL'),
		};
		const create = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
			tag === 'canvas' ? (canvas as unknown as HTMLCanvasElement) : create(tag)
		);
		await expect(downscaleImageDataUrl(src, 320)).resolves.toBe('data:image/webp;base64,SMALL');
		expect(canvas.width).toBe(320);
		expect(canvas.height).toBe(160);
		expect(canvas.toDataURL).toHaveBeenCalledWith('image/webp', 0.85);
	});

	it('returns the image as it was when the canvas cannot draw', async () => {
		vi.mocked(loadImageElement).mockResolvedValue(sized(1600, 800));
		const create = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation((tag: string) =>
			tag === 'canvas' ? ({ getContext: () => null } as unknown as HTMLCanvasElement) : create(tag)
		);
		await expect(downscaleImageDataUrl(src, 320)).resolves.toBe(src);
	});
});
