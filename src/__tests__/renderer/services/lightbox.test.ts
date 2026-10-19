/**
 * Tests for services/lightbox: one open and close for the image lightbox,
 * shared by the app window's modal handlers and a tab window's modal host.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { closeLightbox, openLightbox } from '../../../renderer/services/lightbox';
import { useModalStore } from '../../../renderer/stores/modalStore';

beforeEach(() => {
	closeLightbox();
});

describe('lightbox', () => {
	it('opens on an image with its carousel; only a staged image may be deleted', () => {
		openLightbox('b.png', ['a.png', 'b.png'], 'staged');
		expect(useModalStore.getState().getData('lightbox')).toMatchObject({
			image: 'b.png',
			images: ['a.png', 'b.png'],
			source: 'staged',
			allowDelete: true,
		});

		openLightbox('c.png');
		expect(useModalStore.getState().getData('lightbox')).toMatchObject({
			image: 'c.png',
			images: [],
			source: 'history',
			allowDelete: false,
		});
	});

	it('closes and forgets its carousel', () => {
		openLightbox('a.png', ['a.png']);
		closeLightbox();
		expect(useModalStore.getState().isOpen('lightbox')).toBe(false);
	});
});
