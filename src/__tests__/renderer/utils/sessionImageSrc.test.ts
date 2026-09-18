/**
 * Tests for displayImageSrc.
 *
 * A persisted conversation image is a `maestro-image://store/...` reference.
 * The Electron app loads that scheme natively; the web-desktop bundle cannot,
 * so the reference is rewritten to the web server's token-scoped image route.
 * Before this every stored screenshot rendered as a broken-image glyph on a
 * phone.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayImageSrc } from '../../../renderer/utils/sessionImageSrc';
import { isWebDesktop } from '../../../renderer/utils/runtimeContext';

vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => false),
}));

const mockedIsWebDesktop = vi.mocked(isWebDesktop);

const SHA = 'b'.repeat(64);
const REF = `maestro-image://store/${SHA}.png`;
const DATA_URL = 'data:image/png;base64,AAAA';

function setConfig(config: unknown): void {
	(window as unknown as Record<string, unknown>).__MAESTRO_CONFIG__ = config;
}

afterEach(() => {
	delete (window as unknown as Record<string, unknown>).__MAESTRO_CONFIG__;
	mockedIsWebDesktop.mockReturnValue(false);
});

describe('displayImageSrc', () => {
	it('leaves a store reference alone in the Electron desktop app', () => {
		mockedIsWebDesktop.mockReturnValue(false);
		expect(displayImageSrc(REF)).toBe(REF);
	});

	it('rewrites a store reference to the token-scoped image route in web-desktop', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ apiBase: '/tok/api' });
		expect(displayImageSrc(REF)).toBe(`/tok/api/images/${SHA}.png`);
	});

	it('passes inline data URLs through untouched in both hosts', () => {
		expect(displayImageSrc(DATA_URL)).toBe(DATA_URL);
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ apiBase: '/tok/api' });
		expect(displayImageSrc(DATA_URL)).toBe(DATA_URL);
	});

	it('leaves a malformed reference alone rather than building a path from it', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ apiBase: '/tok/api' });
		const bad = 'maestro-image://store/../../secret.png';
		expect(displayImageSrc(bad)).toBe(bad);
	});

	it('falls back to the reference when the page carries no apiBase', () => {
		mockedIsWebDesktop.mockReturnValue(true);
		setConfig({ securityToken: 'tok' });
		expect(displayImageSrc(REF)).toBe(REF);
	});
});
