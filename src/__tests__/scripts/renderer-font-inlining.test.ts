/**
 * The renderer CSP allows fonts only from 'self', so Vite must never inline a
 * font as a data: URI. Vite inlines any asset under 4 KB by default, which
 * turned KaTeX_Size3.woff2 into a blocked data: font in packaged builds.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UserConfig } from 'vite';
import viteConfig from '../../../vite.config.mts';

const root = path.resolve(__dirname, '../../..');

function resolveConfig(): UserConfig {
	const factory = viteConfig as unknown as (env: { mode: string; command: 'build' }) => UserConfig;
	return factory({ mode: 'production', command: 'build' });
}

type InlineLimit = (filePath: string, content: Buffer) => boolean | undefined;

describe('renderer vite config: font inlining', () => {
	const limit = resolveConfig().build?.assetsInlineLimit as InlineLimit;
	const tiny = Buffer.alloc(16);

	it('still forbids data: fonts in the renderer CSP', () => {
		// If this ever loosens, the inline rule below is no longer needed.
		const html = readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
		expect(html).toMatch(/font-src 'self';/);
	});

	it.each([
		'node_modules/katex/dist/fonts/KaTeX_Size3-Regular.woff2',
		'fonts/Inter.woff',
		'fonts/Mono.TTF',
		'fonts/legacy.otf',
		'fonts/legacy.eot',
	])('never inlines %s, however small', (file) => {
		expect(typeof limit).toBe('function');
		expect(limit(file, tiny)).toBe(false);
	});

	it("leaves every other asset to Vite's default limit", () => {
		expect(limit('src/renderer/assets/icon.svg', tiny)).toBeUndefined();
		expect(limit('src/renderer/assets/logo.png', tiny)).toBeUndefined();
	});
});
