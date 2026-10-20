import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas, loadImage } from 'canvas';
import { beforeAll, describe, expect, it } from 'vitest';
import {
	APERTURE_ASPECT,
	APERTURE_INSET,
	FRAME_ASPECT,
} from '../../../renderer/components/DidYouKnow/frameGeometry';

// If someone recrops or replaces the frame art without re-measuring, this test
// fails instead of artwork silently sitting crooked inside the frame in production.
describe('Did You Know frame asset geometry', () => {
	let width: number;
	let height: number;
	let left: number;
	let right: number;
	let top: number;
	let bottom: number;

	beforeAll(async () => {
		const image = await loadImage(
			readFileSync(resolve(__dirname, '../../../renderer/assets/did-you-know-frame.png'))
		);
		({ width, height } = image);
		const context = createCanvas(width, height).getContext('2d');
		context.drawImage(image, 0, 0);
		const { data } = context.getImageData(0, 0, width, height);
		left = right = Math.floor(width / 2);
		top = bottom = Math.floor(height / 2);
		const center = top * width + left;
		expect(data[center * 4 + 3], 'The aperture center must be fully transparent').toBe(0);

		// Walk the center-connected transparent region, excluding transparent space
		// outside the frame. A single center row/column misses the uneven inner edge.
		const visited = new Uint8Array(width * height);
		const pending = [center];
		visited[center] = 1;
		while (pending.length > 0) {
			const pixel = pending.pop()!;
			const x = pixel % width;
			const y = Math.floor(pixel / width);
			left = Math.min(left, x);
			right = Math.max(right, x);
			top = Math.min(top, y);
			bottom = Math.max(bottom, y);
			for (const [nx, ny] of [
				[x - 1, y],
				[x + 1, y],
				[x, y - 1],
				[x, y + 1],
			]) {
				if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
				const neighbor = ny * width + nx;
				if (visited[neighbor] || data[neighbor * 4 + 3] !== 0) continue;
				visited[neighbor] = 1;
				pending.push(neighbor);
			}
		}
		// Bounds below use exclusive right/bottom edges, matching CSS insets.
		right += 1;
		bottom += 1;
	});

	it('matches the measured aperture insets within half a percentage point', () => {
		const measured = {
			left: (left / width) * 100,
			top: (top / height) * 100,
			right: ((width - right) / width) * 100,
			bottom: ((height - bottom) / height) * 100,
		};
		for (const side of ['left', 'top', 'right', 'bottom'] as const) {
			expect(measured[side], `${side} must remain enclosed by the frame`).toBeGreaterThan(0);
			expect(
				Math.abs(measured[side] - APERTURE_INSET[side]),
				`${side} inset drift`
			).toBeLessThanOrEqual(0.5);
		}
	});

	it('matches the full frame aspect ratio', () => {
		expect(width / height).toBeCloseTo(FRAME_ASPECT, 4);
	});

	it('matches the measured aperture aspect ratio', () => {
		// Fully transparent pixels stop inside the antialiased edge, so allow
		// half a percent of relative error against the artwork crop ratio.
		const measuredAspect = (right - left) / (bottom - top);
		expect(Math.abs(measuredAspect / APERTURE_ASPECT - 1)).toBeLessThanOrEqual(0.005);
	});
});
