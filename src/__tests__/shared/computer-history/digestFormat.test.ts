import { describe, expect, it } from 'vitest';
import {
	DIGEST_ACCURACY_RULES,
	DIGEST_SECTIONS,
	MAX_DIGEST_BULLETS,
	MAX_ROLLUP_BULLETS,
	digestFormatInstructions,
	formatDigestSources,
} from '../../../shared/computer-history/digestFormat';

// Built from code points so no formatter can turn the escapes into the characters.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

describe('digestFormatInstructions', () => {
	it('asks for a title, a one-sentence lede, and the three sections in order', () => {
		for (const kind of ['15m', '6h'] as const) {
			const text = digestFormatInstructions(kind);
			const threads = text.indexOf(`### ${DIGEST_SECTIONS.threads}`);
			const open = text.indexOf(`### ${DIGEST_SECTIONS.open}`);
			const context = text.indexOf(`### ${DIGEST_SECTIONS.context}`);
			expect(text).toMatch(/\*\*<a title/);
			expect(threads).toBeGreaterThan(0);
			expect(open).toBeGreaterThan(threads);
			expect(context).toBeGreaterThan(open);
			expect(text).toContain('- None seen.');
			expect(text).not.toMatch(DASHES);
		}
	});

	it('caps bullets per kind and asks a roll-up for end-of-block state', () => {
		expect(digestFormatInstructions('15m')).toContain(`at most ${MAX_DIGEST_BULLETS} bullets`);
		expect(digestFormatInstructions('6h')).toContain(`at most ${MAX_ROLLUP_BULLETS} bullets`);
		expect(digestFormatInstructions('15m')).toContain('15 minutes');
		expect(digestFormatInstructions('6h')).toContain('end of the block');
	});

	it('names the accuracy mistakes small models make', () => {
		expect(DIGEST_ACCURACY_RULES).toMatch(/report what they wrote/);
		expect(DIGEST_ACCURACY_RULES).toMatch(/not an app or a window/);
		expect(DIGEST_ACCURACY_RULES).toMatch(/one-time code/);
		expect(DIGEST_ACCURACY_RULES).toMatch(/drafts of one message/);
		expect(DIGEST_ACCURACY_RULES).not.toMatch(DASHES);
	});
});

describe('formatDigestSources', () => {
	it('lists store-relative paths under a Sources heading', () => {
		expect(
			formatDigestSources(['digests/2026-11-11/1800Z.md', 'digests/2026-11-11/1815Z.md'])
		).toBe('### Sources\n\n- `digests/2026-11-11/1800Z.md`\n- `digests/2026-11-11/1815Z.md`');
	});

	it('is empty with no sources', () => {
		expect(formatDigestSources([])).toBe('');
	});
});
