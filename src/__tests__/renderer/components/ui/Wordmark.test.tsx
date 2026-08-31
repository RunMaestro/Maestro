import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Wordmark } from '../../../../renderer/components/ui/Wordmark';
import { WORDMARK_FONT_STACK } from '../../../../shared/fontStack';

/** jsdom re-quotes font families, so compare on the family names alone. */
function normalizeFontStack(value: string): string {
	return value
		.replace(/['"]/g, '')
		.replace(/\s*,\s*/g, ',')
		.trim();
}

/** CSS comments may legitimately mention things the rules must not contain. */
function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

const REPO_ROOT = path.join(__dirname, '../../../../..');

afterEach(() => {
	cleanup();
});

describe('Wordmark', () => {
	it('renders the brand mark', () => {
		render(<Wordmark testId="wm" />);
		expect(screen.getByTestId('wm')).toHaveTextContent('MAESTRO');
	});

	it('pins the brand font regardless of the interface font', () => {
		// The mark is the one string in the app whose shape is the point. It used
		// to inherit the interface font, so changing a reading preference changed
		// the logo.
		render(<Wordmark testId="wm" />);
		expect(normalizeFontStack(screen.getByTestId('wm').style.fontFamily)).toBe(
			normalizeFontStack(WORDMARK_FONT_STACK)
		);
	});

	it('ignores a caller trying to re-type it', () => {
		// fontFamily is excluded from the style prop, so this is a type error too -
		// but the runtime behaviour is what actually protects the mark.
		render(<Wordmark testId="wm" style={{ fontFamily: 'Comic Sans MS' } as React.CSSProperties} />);
		expect(normalizeFontStack(screen.getByTestId('wm').style.fontFamily)).toBe(
			normalizeFontStack(WORDMARK_FONT_STACK)
		);
	});

	it('keeps weight and tracking, which are part of the mark', () => {
		render(<Wordmark testId="wm" />);
		const el = screen.getByTestId('wm');
		expect(el.className).toContain('font-bold');
		expect(el.className).toContain('tracking-widest');
	});

	it('lets the caller set the size, which legitimately varies', () => {
		// A header and an About screen draw the same mark at different scales.
		render(<Wordmark testId="wm" className="text-6xl" />);
		expect(screen.getByTestId('wm').className).toContain('text-6xl');
	});

	it('honours colour and layout styles', () => {
		render(<Wordmark testId="wm" style={{ color: 'rgb(1, 2, 3)' }} />);
		expect(screen.getByTestId('wm').style.color).toBe('rgb(1, 2, 3)');
	});

	it('renders as the requested element', () => {
		render(<Wordmark as="h1" testId="wm" />);
		expect(screen.getByTestId('wm').tagName).toBe('H1');
	});
});

describe('boot splash wordmarks', () => {
	/**
	 * Both splash screens paint before any JavaScript runs, so they cannot
	 * import WORDMARK_FONT_STACK and carry a hand-synced copy instead. These
	 * assert the copies have not drifted - and, for the web splash, that it
	 * declares a font at all: it previously inherited `body`, which resolves
	 * --maestro-font-interface, so the logo followed the user's reading font.
	 */
	const leadingFamily = WORDMARK_FONT_STACK.split(',')[0].trim();

	it.each([
		['src/renderer/index.html', '.splash-title'],
		['src/web-desktop/index.html', '.md-splash__wordmark'],
	])('%s declares the brand font on %s', (file, selector) => {
		const html = readFileSync(path.join(REPO_ROOT, file), 'utf8');
		const block = new RegExp(`\\${selector}\\s*\\{[^}]*\\}`).exec(html)?.[0] ?? '';

		expect(block).toBeTruthy();
		expect(block).toContain('font-family');
		expect(block).toContain(leadingFamily);
	});

	it('never points a splash wordmark at the interface font variable', () => {
		for (const file of ['src/renderer/index.html', 'src/web-desktop/index.html']) {
			const html = readFileSync(path.join(REPO_ROOT, file), 'utf8');
			const block =
				/\.splash-title\s*\{[^}]*\}/.exec(html)?.[0] ??
				/\.md-splash__wordmark\s*\{[^}]*\}/.exec(html)?.[0] ??
				'';
			// Comments explain WHY the variable is avoided, so strip them before
			// asserting the rules themselves never reference it.
			expect(stripCssComments(block)).not.toContain('--maestro-font-interface');
		}
	});
});
