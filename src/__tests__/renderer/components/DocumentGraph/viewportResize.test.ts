import { describe, it, expect } from 'vitest';
import { transformAfterResize } from '../../../../renderer/components/DocumentGraph/viewportResize';

describe('transformAfterResize', () => {
	const size = { width: 1000, height: 800 };

	it('returns the current transform when the size did not change', () => {
		const current = { zoom: 2, panX: 10, panY: 20 };
		expect(transformAfterResize(current, null, size, { ...size })).toBe(current);
	});

	it('re-fits a view the user has not moved since the last fit', () => {
		const fit = { zoom: 0.5, panX: 100, panY: 50 };
		expect(transformAfterResize(fit, fit, size, { width: 1000, height: 764 })).toBe('refit');
	});

	it('keeps the zoom of a view the user moved, and holds the viewport center', () => {
		// Selecting a node shows the info bar, which shrinks the canvas height.
		const fit = { zoom: 0.5, panX: 100, panY: 50 };
		const zoomedIn = { zoom: 2.5, panX: -300, panY: -200 };
		const next = transformAfterResize(zoomedIn, fit, size, { width: 1000, height: 764 });
		expect(next).toEqual({ zoom: 2.5, panX: -300, panY: -218 });
	});

	it('treats an equal-valued but different transform object as moved', () => {
		const fit = { zoom: 1, panX: 0, panY: 0 };
		const next = transformAfterResize({ ...fit }, fit, size, { width: 1200, height: 800 });
		expect(next).toEqual({ zoom: 1, panX: 100, panY: 0 });
	});
});
