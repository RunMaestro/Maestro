import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MermaidRenderer } from '../../../renderer/components/MermaidRenderer';
import { createMockTheme, mockTheme } from '../../helpers/mockTheme';

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

beforeEach(() => {
	renderMock.mockReset();
});

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

	it('renders a standard flowchart SVG', async () => {
		renderMock.mockResolvedValue({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><rect width="10" height="10"/></g></svg>',
		});

		const { container } = render(<MermaidRenderer chart="flowchart LR\nA-->B" theme={mockTheme} />);

		await waitFor(() => {
			expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
		});
	});

	it('does not re-render or flash loading for an equivalent theme object', async () => {
		renderMock.mockResolvedValue({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><g><text>stable</text></g></svg>',
		});

		const chart = 'flowchart LR\nStable-->Theme';
		const { container, queryByText, rerender, unmount } = render(
			<MermaidRenderer chart={chart} theme={mockTheme} />
		);

		await waitFor(() => {
			expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
		});
		expect(renderMock).toHaveBeenCalledTimes(1);

		rerender(<MermaidRenderer chart={chart} theme={createMockTheme()} />);

		expect(queryByText('Rendering diagram...')).not.toBeInTheDocument();
		expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
		expect(renderMock).toHaveBeenCalledTimes(1);

		unmount();
		const remount = render(<MermaidRenderer chart={chart} theme={createMockTheme()} />);

		expect(remount.queryByText('Rendering diagram...')).not.toBeInTheDocument();
		expect(remount.container.querySelector('.mermaid-container svg')).not.toBeNull();
		expect(renderMock).toHaveBeenCalledTimes(1);
	});
});
