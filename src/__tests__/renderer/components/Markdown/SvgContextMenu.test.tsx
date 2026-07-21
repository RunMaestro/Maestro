/**
 * Right-click "Copy Image / Save Image" menu on rendered diagrams. Two distinct
 * paths have to work: agent-authored inline <svg> (React-rendered) and Mermaid
 * charts (injected imperatively into a container div).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkdownRenderer } from '../../../../renderer/components/MarkdownRenderer';
import { MermaidRenderer } from '../../../../renderer/components/MermaidRenderer';
import { mockTheme } from '../../../helpers/mockTheme';

const { mockCopySvgToClipboard, mockDownloadSvg } = vi.hoisted(() => ({
	mockCopySvgToClipboard: vi.fn<(svg: SVGSVGElement) => Promise<'image' | 'markup' | 'failed'>>(),
	mockDownloadSvg: vi.fn(),
}));

vi.mock('../../../../renderer/utils/svgExport', () => ({
	copySvgToClipboard: mockCopySvgToClipboard,
	downloadSvg: mockDownloadSvg,
}));

const { mockCenterFlash } = vi.hoisted(() => ({ mockCenterFlash: vi.fn() }));
vi.mock('../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: mockCenterFlash,
}));

// Mermaid renders asynchronously via the real library in jsdom; stub it so the
// test controls exactly what SVG lands in the container.
vi.mock('mermaid', () => ({
	default: {
		initialize: vi.fn(),
		parse: vi.fn(async () => true),
		render: vi.fn(async () => ({
			svg: '<svg id="mermaid-1"><rect width="10" height="10"/></svg>',
		})),
	},
}));

const INLINE_SVG = [
	'Here is a diagram:',
	'',
	'<svg width="100" height="40" viewBox="0 0 100 40" xmlns="http://www.w3.org/2000/svg">',
	'  <rect width="100" height="40" fill="red" />',
	'</svg>',
	'',
	'Done.',
].join('\n');

describe('SVG right-click menu', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCopySvgToClipboard.mockResolvedValue('image');
	});

	it('opens on right-click of an agent-authored inline <svg> in chat', async () => {
		const { container } = render(
			<MarkdownRenderer content={INLINE_SVG} theme={mockTheme} onCopy={vi.fn()} />
		);

		const svg = container.querySelector('svg');
		expect(svg).not.toBeNull();

		fireEvent.contextMenu(svg as SVGSVGElement, { clientX: 10, clientY: 10 });

		await waitFor(() => expect(screen.getByText('Copy Image')).toBeTruthy());
		expect(screen.getByText(/Save Image/)).toBeTruthy();
	});

	it('opens on right-click of a Mermaid diagram', async () => {
		const { container } = render(<MermaidRenderer chart="graph TD; A-->B;" theme={mockTheme} />);

		await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());

		fireEvent.contextMenu(container.querySelector('.mermaid-container') as HTMLElement, {
			clientX: 20,
			clientY: 20,
		});

		await waitFor(() => expect(screen.getByText('Copy Image')).toBeTruthy());
		expect(screen.getByText(/Save Image/)).toBeTruthy();
	});

	it('copies the Mermaid <svg> element itself, not the container', async () => {
		const { container } = render(<MermaidRenderer chart="graph TD; A-->B;" theme={mockTheme} />);
		await waitFor(() => expect(container.querySelector('svg')).not.toBeNull());
		const svg = container.querySelector('svg');

		fireEvent.contextMenu(container.querySelector('.mermaid-container') as HTMLElement, {
			clientX: 20,
			clientY: 20,
		});
		await waitFor(() => expect(screen.getByText('Copy Image')).toBeTruthy());
		fireEvent.click(screen.getByText('Copy Image'));

		await waitFor(() => expect(mockCopySvgToClipboard).toHaveBeenCalledWith(svg));
	});

	it('saves the diagram to disk from the menu', async () => {
		const { container } = render(
			<MarkdownRenderer content={INLINE_SVG} theme={mockTheme} onCopy={vi.fn()} />
		);
		const svg = container.querySelector('svg');

		fireEvent.contextMenu(svg as SVGSVGElement, { clientX: 10, clientY: 10 });
		await waitFor(() => expect(screen.getByText(/Save Image/)).toBeTruthy());
		fireEvent.click(screen.getByText(/Save Image/));

		expect(mockDownloadSvg).toHaveBeenCalledWith(svg);
	});

	it('reports a red flash instead of a false "copied" when the copy fails', async () => {
		mockCopySvgToClipboard.mockResolvedValue('failed');
		const { container } = render(
			<MarkdownRenderer content={INLINE_SVG} theme={mockTheme} onCopy={vi.fn()} />
		);

		fireEvent.contextMenu(container.querySelector('svg') as SVGSVGElement, {
			clientX: 10,
			clientY: 10,
		});
		await waitFor(() => expect(screen.getByText('Copy Image')).toBeTruthy());
		fireEvent.click(screen.getByText('Copy Image'));

		await waitFor(() =>
			expect(mockCenterFlash).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'Could Not Copy Image', color: 'red' })
			)
		);
	});
});
