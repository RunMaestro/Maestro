import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import mermaid from 'mermaid';
import { MermaidRenderer } from '../../../renderer/components/MermaidRenderer';
import { createMockTheme, mockTheme } from '../../helpers/mockTheme';
import { AA_CONTRAST, contrastRatio } from '../../../shared/colorContrast';
import type { ThemeColors } from '../../../shared/theme-types';

// Mermaid is a static default import in MermaidRenderer. We stub parse (always
// valid) and render (returns a caller-supplied SVG) so each test controls the
// exact SVG markup that flows through the sanitize + reparse path.
const renderMock = vi.fn();
vi.mock('mermaid', () => ({
	default: {
		initialize: vi.fn(),
		parse: vi.fn(async () => true),
		render: vi.fn((id: string, source: string) => renderMock(id, source)),
	},
}));

const initializeMock = vi.mocked(mermaid.initialize);

beforeEach(() => {
	renderMock.mockReset();
	initializeMock.mockClear();
});

/**
 * Render once with a uniquely-named theme and return the themeVariables handed
 * to `mermaid.initialize`. The component re-initializes only when the theme name
 * changes (module-level cache), so each caller needs its own name.
 */
async function captureThemeVariables(
	name: string,
	colors: Partial<ThemeColors>
): Promise<Record<string, string>> {
	renderMock.mockResolvedValue({
		svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g/></svg>',
	});
	const theme = createMockTheme({ name, colors });
	const { container } = render(<MermaidRenderer chart="erDiagram\nA {}" theme={theme} />);
	await waitFor(() => {
		expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
	});

	const calls = initializeMock.mock.calls;
	const config = calls[calls.length - 1]?.[0] as
		| { themeVariables?: Record<string, string> }
		| undefined;
	expect(config?.themeVariables).toBeDefined();
	return config!.themeVariables!;
}

describe('MermaidRenderer', () => {
	it('renders a diagram whose SVG uses xlink:href without an xmlns:xlink declaration', async () => {
		// This mirrors Mermaid's C4 output: an <image xlink:href> without the
		// xmlns:xlink namespace declared on the root <svg>. A strict
		// image/svg+xml reparse rejects this (blank diagram) - the regression
		// this test guards. The renderer must parse it leniently and mount it.
		renderMock.mockResolvedValue({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-roledescription="c4"><image xlink:href="sprite.png" x="0" y="0"/><g/></svg>',
		});

		const { container } = render(<MermaidRenderer chart="C4Context" theme={mockTheme} />);

		await waitFor(() => {
			expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
		});
		// The xlink:href element survives into the mounted DOM.
		expect(container.querySelector('.mermaid-container svg image')).not.toBeNull();
	});

	describe('foreignObject labels (htmlLabels: true)', () => {
		// Mermaid renders flowchart labels as HTML inside <foreignObject>, so a
		// `<br/>` in `A[Visibility only.<br/>Observation]` is a real <br> element.
		// DOMPurify's defaults (SVG-only profile + foreignObject not being an HTML
		// integration point) used to delete that whole subtree and leave the bare
		// text, which collapsed the line break, re-wrapped the text at the
		// foreignObject width, and clipped whatever no longer fit the height
		// mermaid had measured. Diagram content was lost, not just restyled.
		const labelSvg = (inner: string) =>
			`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><foreignObject width="120" height="40">${inner}</foreignObject></g></svg>`;

		it('keeps the <br> and its wrapper markup in a node label', async () => {
			renderMock.mockResolvedValue({
				svg: labelSvg(
					'<div xmlns="http://www.w3.org/1999/xhtml" style="display: table-cell;" class="labelBkg"><span class="nodeLabel"><p>Visibility only.<br/>Observation, not control</p></span></div>'
				),
			});

			const { container } = render(
				<MermaidRenderer chart="flowchart LR\nA[x]" theme={mockTheme} />
			);

			await waitFor(() => {
				expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
			});

			const label = container.querySelector('.mermaid-container foreignObject');
			expect(label).not.toBeNull();
			expect(label?.querySelector('br')).not.toBeNull();
			expect(label?.querySelector('span.nodeLabel')).not.toBeNull();
			// The break must sit BETWEEN the two halves, not be dropped so the text
			// collapses into "Visibility only.Observation".
			expect(label?.innerHTML).toContain('Visibility only.<br>Observation, not control');
		});

		it('still strips scripts and event handlers from inside a foreignObject', async () => {
			renderMock.mockResolvedValue({
				svg: labelSvg(
					'<div xmlns="http://www.w3.org/1999/xhtml"><script>globalThis.pwned = 1;</script><img src="x" onerror="globalThis.pwned = 1"/><iframe src="javascript:1"></iframe><a href="javascript:1">z</a></div>'
				),
			});

			const { container } = render(
				<MermaidRenderer chart="flowchart LR\nA[x]" theme={mockTheme} />
			);

			await waitFor(() => {
				expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
			});

			const mounted = container.querySelector('.mermaid-container')!;
			expect(mounted.querySelector('script')).toBeNull();
			expect(mounted.querySelector('iframe')).toBeNull();
			expect(mounted.querySelector('[onerror]')).toBeNull();
			expect(mounted.querySelector('a[href]')).toBeNull();
		});
	});

	it('renders a standard flowchart SVG', async () => {
		renderMock.mockResolvedValue({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><rect width="10" height="10"/></g></svg>',
		});

		const { container } = render(<MermaidRenderer chart="flowchart LR\nA-->B" theme={mockTheme} />);

		await waitFor(() => {
			expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
		});
	});

	describe('theme contrast', () => {
		it('pins ER attribute row fills so labels stay readable', async () => {
			// Regression: Mermaid's base theme derives rowOdd from
			// lighten(primaryColor, 75), which renders a near-white attribute row
			// on a dark theme while the label keeps the theme's light text color -
			// the row text was effectively invisible. Both stripes must now be
			// supplied by us and clear AA against the label color.
			const vars = await captureThemeVariables('contrast-dark', {
				bgMain: '#282a36',
				textMain: '#f8f8f2',
				accent: '#bd93f9',
			});

			expect(vars.rowOdd).toBeDefined();
			expect(vars.rowEven).toBeDefined();
			expect(contrastRatio(vars.nodeTextColor, vars.rowOdd)).toBeGreaterThanOrEqual(AA_CONTRAST);
			expect(contrastRatio(vars.nodeTextColor, vars.rowEven)).toBeGreaterThanOrEqual(AA_CONTRAST);
		});

		it('keeps node labels readable on every node fill', async () => {
			const vars = await captureThemeVariables('contrast-fills', {
				bgMain: '#282a36',
				textMain: '#f8f8f2',
				accent: '#bd93f9',
				success: '#50fa7b',
				warning: '#ffb86c',
			});

			for (const fill of [vars.primaryColor, vars.secondaryColor, vars.tertiaryColor]) {
				expect(contrastRatio(vars.nodeTextColor, fill)).toBeGreaterThanOrEqual(AA_CONTRAST);
			}
		});

		it('rescues a theme whose text color collides with its own node fills', async () => {
			// A low-contrast theme (text barely distinct from the tinted fill)
			// must not be passed through unchanged.
			const vars = await captureThemeVariables('contrast-collision', {
				bgMain: '#3a3a3a',
				textMain: '#454545',
				accent: '#4a4a4a',
				success: '#4a4a4a',
				warning: '#4a4a4a',
			});

			expect(vars.nodeTextColor).not.toBe('#454545');
			expect(contrastRatio(vars.nodeTextColor, vars.rowOdd)).toBeGreaterThanOrEqual(AA_CONTRAST);
		});

		it('uses a contrasting foreground for text painted on the accent', async () => {
			const vars = await captureThemeVariables('contrast-accent', {
				accent: '#bd93f9',
				accentForeground: '#bb91f7', // near-identical to the accent
			});

			expect(contrastRatio(vars.taskTextColor, '#bd93f9')).toBeGreaterThanOrEqual(AA_CONTRAST);
			expect(vars.sequenceNumberColor).toBe(vars.taskTextColor);
		});
	});
});
