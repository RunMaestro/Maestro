/**
 * Tests for Layer type system utilities
 */

import { describe, it, expect, vi } from 'vitest';
import {
	isModalLayer,
	isOverlayLayer,
	Layer,
	ModalLayer,
	OverlayLayer,
} from '../../../renderer/types/layer';

function createModalLayer(overrides: Partial<ModalLayer> = {}): ModalLayer {
	return {
		id: 'test-modal',
		type: 'modal',
		priority: 100,
		blocksLowerLayers: true,
		capturesFocus: true,
		focusTrap: 'strict',
		onEscape: vi.fn(),
		...overrides,
	};
}

function createOverlayLayer(overrides: Partial<OverlayLayer> = {}): OverlayLayer {
	return {
		id: 'test-overlay',
		type: 'overlay',
		priority: 50,
		blocksLowerLayers: false,
		capturesFocus: false,
		focusTrap: 'none',
		onEscape: vi.fn(),
		allowClickOutside: true,
		...overrides,
	};
}

describe('Layer type guards', () => {
	it('isModalLayer returns true for modal layers', () => {
		expect(isModalLayer(createModalLayer())).toBe(true);
		expect(isModalLayer(createOverlayLayer())).toBe(false);
	});

	it('isOverlayLayer returns true for overlay layers', () => {
		expect(isOverlayLayer(createOverlayLayer())).toBe(true);
		expect(isOverlayLayer(createModalLayer())).toBe(false);
	});

	it('type guards work with array filtering', () => {
		const layers: Layer[] = [
			createModalLayer({ id: 'modal-1' }),
			createOverlayLayer({ id: 'overlay-1' }),
			createModalLayer({ id: 'modal-2' }),
		];

		const modals = layers.filter(isModalLayer);
		const overlays = layers.filter(isOverlayLayer);

		expect(modals).toHaveLength(2);
		expect(overlays).toHaveLength(1);
		expect(modals.map((m) => m.id)).toEqual(['modal-1', 'modal-2']);
	});
});
