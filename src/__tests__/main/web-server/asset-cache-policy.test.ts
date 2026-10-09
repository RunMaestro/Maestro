import { describe, expect, it } from 'vitest';
import path from 'path';
import {
	IMMUTABLE_ASSET_CACHE_CONTROL,
	isContentHashedAsset,
} from '../../../main/web-server/asset-cache-policy';

const root = path.join(path.sep, 'bundle', 'web-desktop', 'assets');
const at = (...parts: string[]) => path.join(root, ...parts);

describe('isContentHashedAsset', () => {
	it('accepts the names Vite emits at the top of assets/', () => {
		expect(isContentHashedAsset(root, at('main-BOEbwE3b.js'))).toBe(true);
		expect(isContentHashedAsset(root, at('main-Cq2Yd8xP.css'))).toBe(true);
		// Hashes are base64url, so they can end in `-` or contain `_`.
		expect(isContentHashedAsset(root, at('material-theme-ocean-DKjK2GC-.js'))).toBe(true);
		expect(isContentHashedAsset(root, at('KaTeX_Math-Italic-flOr_0UB.ttf'))).toBe(true);
		expect(isContentHashedAsset(root, at('main-BOEbwE3b.js.map'))).toBe(true);
	});

	it('keeps the unhashed fonts folder revalidating', () => {
		// The bundled-fonts plugin copies these in under stable names, so a font
		// replaced in place would be served stale for a year if marked immutable.
		expect(isContentHashedAsset(root, at('fonts', 'inter-latin-400_700-1.woff2'))).toBe(false);
		expect(isContentHashedAsset(root, at('fonts', 'sub-BOEbwE3b.woff2'))).toBe(false);
	});

	it('rejects names without a hash suffix', () => {
		expect(isContentHashedAsset(root, at('main.js'))).toBe(false);
		expect(isContentHashedAsset(root, at('roboto-latin-400_700-1.woff2'))).toBe(false);
		expect(isContentHashedAsset(root, at('vendor-short.js'))).toBe(false);
	});

	it('rejects anything outside the assets root', () => {
		expect(isContentHashedAsset(root, path.join(root, '..', 'index-BOEbwE3b.js'))).toBe(false);
		expect(isContentHashedAsset(root, root)).toBe(false);
	});

	it('marks hashed files immutable for a year', () => {
		expect(IMMUTABLE_ASSET_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
	});
});
