import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent, act, screen } from '@testing-library/react';
import {
	LocalImage,
	resolveLocalImagePath,
} from '../../../../renderer/components/Markdown/components/LocalImage';
import { mockTheme } from '../../../helpers/mockTheme';
import { useZoomViewerStore } from '../../../../renderer/components/ZoomViewer/zoomViewerStore';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const readFile = vi.fn().mockResolvedValue(PNG);

beforeEach(() => {
	readFile.mockClear();
	(globalThis as any).window.maestro = { fs: { readFile } };
});

describe('resolveLocalImagePath', () => {
	// mdast-util-to-hast percent-encodes every image destination, so a real path
	// with a space arrives here as `%20` and would ENOENT if read verbatim.
	it('percent-decodes a bare absolute path', () => {
		expect(resolveLocalImagePath('/Users/p/Prop%20Firm%20Model/model.png')).toBe(
			'/Users/p/Prop Firm Model/model.png'
		);
	});

	it('strips the file:// prefix and decodes', () => {
		expect(resolveLocalImagePath('file:///Users/p/My%20Notes/a.png')).toBe(
			'/Users/p/My Notes/a.png'
		);
	});

	it('leaves a malformed percent sequence alone instead of throwing', () => {
		expect(resolveLocalImagePath('/Users/p/100%/chart.png')).toBe('/Users/p/100%/chart.png');
	});

	it('is a no-op for a path with nothing to decode', () => {
		expect(resolveLocalImagePath('/Users/p/notes/a.png')).toBe('/Users/p/notes/a.png');
	});
});

describe('LocalImage', () => {
	it('reads the decoded path for a space-bearing bare path', async () => {
		render(
			<LocalImage src="/Users/p/Prop%20Firm%20Model/model.png" alt="model" theme={mockTheme} />
		);
		await waitFor(() => expect(readFile).toHaveBeenCalled());
		expect(readFile).toHaveBeenCalledWith('/Users/p/Prop Firm Model/model.png', undefined);
	});

	it('reads the decoded path for a file:// URL', async () => {
		render(<LocalImage src="file:///Users/p/My%20Notes/a.png" alt="a" theme={mockTheme} />);
		await waitFor(() => expect(readFile).toHaveBeenCalled());
		expect(readFile).toHaveBeenCalledWith('/Users/p/My Notes/a.png', undefined);
	});

	it('renders http(s) sources without an IPC read', () => {
		const { container } = render(
			<LocalImage src="https://example.com/a.png" alt="a" theme={mockTheme} />
		);
		expect(readFile).not.toHaveBeenCalled();
		expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/a.png');
	});
});

describe('LocalImage zoom viewer', () => {
	beforeEach(() => {
		act(() => useZoomViewerStore.getState().close());
	});

	it('opens the image in the pan/zoom viewer on click', () => {
		const { container } = render(
			<LocalImage src="https://example.com/a.png" alt="chart" theme={mockTheme} />
		);
		const img = container.querySelector('img')!;
		fireEvent.click(img);
		const request = useZoomViewerStore.getState().request;
		expect(request?.element).toBe(img);
		expect(request?.title).toBe('chart');
	});

	it('leaves a click on a linked image to the link, but the expand button still opens it', () => {
		const { container } = render(
			<a href="https://example.com">
				<LocalImage src="https://example.com/a.png" alt="chart" theme={mockTheme} />
			</a>
		);
		fireEvent.click(container.querySelector('img')!);
		expect(useZoomViewerStore.getState().request).toBeNull();

		fireEvent.click(screen.getByTestId('expand-to-viewer'));
		expect(useZoomViewerStore.getState().request?.element).toBe(container.querySelector('img'));
	});
});
