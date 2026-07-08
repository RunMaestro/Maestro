import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidRenderer } from '../../../renderer/components/MermaidRenderer';
import type { Theme } from '../../../renderer/types';

const mermaidMock = vi.hoisted(() => ({
	initialize: vi.fn(),
	parse: vi.fn(),
	render: vi.fn(),
}));

const domPurifyMock = vi.hoisted(() => ({
	sanitize: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
	error: vi.fn(),
}));

vi.mock('mermaid', () => ({
	default: mermaidMock,
}));

vi.mock('dompurify', () => ({
	default: domPurifyMock,
}));

vi.mock('../../../renderer/utils/logger', () => ({
	logger: loggerMock,
}));

const darkTheme: Theme = {
	id: 'custom',
	name: 'Dark Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		border: '#303030',
		textMain: '#f8f8f8',
		textDim: '#a0a0a0',
		accent: '#4f8cff',
		accentDim: '#4f8cff33',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#3fb950',
		warning: '#d29922',
		error: '#f85149',
	},
};

const lightTheme: Theme = {
	id: 'custom',
	name: 'Light Test Theme',
	mode: 'light',
	colors: {
		bgMain: '#ffffff',
		bgSidebar: '#f6f8fa',
		bgActivity: '#f0f3f6',
		border: '#d0d7de',
		textMain: '#24292f',
		textDim: '#57606a',
		accent: '#0969da',
		accentDim: '#0969da33',
		accentText: '#0969da',
		accentForeground: '#ffffff',
		success: '#1a7f37',
		warning: '#9a6700',
		error: '#cf222e',
	},
};

beforeEach(() => {
	mermaidMock.initialize.mockClear();
	mermaidMock.parse.mockReset();
	mermaidMock.render.mockReset();
	domPurifyMock.sanitize.mockReset();
	loggerMock.error.mockClear();
	mermaidMock.parse.mockResolvedValue(undefined);
	mermaidMock.render.mockResolvedValue({
		svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered diagram</text></svg>',
	});
	domPurifyMock.sanitize.mockImplementation((svg: string) => svg);
});

afterEach(() => {
	vi.restoreAllMocks();
	document.querySelectorAll('[id^="dmermaid-"]').forEach((element) => element.remove());
});

describe('MermaidRenderer', () => {
	it('renders nothing for an empty chart without invoking Mermaid', async () => {
		const { container } = render(<MermaidRenderer chart="   " theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.queryByText('Rendering diagram...')).not.toBeInTheDocument();
		});

		expect(container.querySelector('.mermaid-container')).toBeInTheDocument();
		expect(mermaidMock.initialize).not.toHaveBeenCalled();
		expect(mermaidMock.parse).not.toHaveBeenCalled();
		expect(mermaidMock.render).not.toHaveBeenCalled();
	});

	it('initializes Mermaid, validates, renders, sanitizes, and appends the SVG', async () => {
		const theme = { ...darkTheme, name: 'Render Flow Theme' };
		const { container } = render(<MermaidRenderer chart={'  graph TD\nA-->B  '} theme={theme} />);

		expect(screen.getByText('Rendering diagram...')).toBeInTheDocument();

		await waitFor(() => {
			expect(container.querySelector('.mermaid-container svg')).toBeInTheDocument();
		});

		expect(mermaidMock.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				startOnLoad: false,
				theme: 'base',
				securityLevel: 'strict',
				suppressErrorRendering: true,
				themeVariables: expect.objectContaining({
					background: theme.colors.bgMain,
					primaryBorderColor: theme.colors.accent,
				}),
			})
		);
		expect(mermaidMock.parse).toHaveBeenCalledWith('graph TD\nA-->B');
		expect(mermaidMock.render).toHaveBeenCalledWith(
			expect.stringMatching(/^mermaid-/),
			'graph TD\nA-->B'
		);
		expect(domPurifyMock.sanitize).toHaveBeenCalledWith(
			'<svg xmlns="http://www.w3.org/2000/svg"><text>Rendered diagram</text></svg>',
			expect.objectContaining({
				USE_PROFILES: { svg: true, svgFilters: true },
				ADD_TAGS: ['foreignObject'],
			})
		);
	});

	it('falls back gracefully when theme colors are not hex values', async () => {
		const cssVariableTheme = {
			...darkTheme,
			name: 'CSS Variable Theme',
			colors: {
				...darkTheme.colors,
				bgMain: 'var(--bg-main)',
				accent: 'var(--accent)',
			},
		};

		render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={cssVariableTheme} />);

		await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());
		expect(mermaidMock.initialize).toHaveBeenCalledWith(
			expect.objectContaining({
				themeVariables: expect.objectContaining({
					background: 'var(--bg-main)',
					git4: 'var(--accent)',
				}),
			})
		);
	});

	it('reuses initialization for the same theme and reinitializes when the theme changes', async () => {
		const firstTheme = { ...darkTheme, name: 'Reusable Dark Theme' };
		const secondTheme = { ...lightTheme, name: 'Reusable Light Theme' };
		const { rerender } = render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={firstTheme} />);

		await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
		const initializeCount = mermaidMock.initialize.mock.calls.length;

		rerender(<MermaidRenderer chart={'graph TD\nB-->C'} theme={firstTheme} />);

		await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(2));
		expect(mermaidMock.initialize).toHaveBeenCalledTimes(initializeCount);

		rerender(<MermaidRenderer chart={'graph TD\nC-->D'} theme={secondTheme} />);

		await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(3));
		expect(mermaidMock.initialize).toHaveBeenCalledTimes(initializeCount + 1);
		expect(mermaidMock.initialize).toHaveBeenLastCalledWith(
			expect.objectContaining({
				themeVariables: expect.objectContaining({
					background: secondTheme.colors.bgMain,
				}),
			})
		);
	});

	it('shows parse errors with the original chart source and skips rendering', async () => {
		mermaidMock.parse.mockRejectedValueOnce(new Error('bad syntax'));

		render(<MermaidRenderer chart={'graph TD\nA-->'} theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Failed to render Mermaid diagram')).toBeInTheDocument();
		});

		expect(screen.getByText('bad syntax')).toBeInTheDocument();
		expect(
			screen.getByText(
				(_, element) => element?.tagName === 'PRE' && element.textContent === 'graph TD\nA-->'
			)
		).toBeInTheDocument();
		expect(mermaidMock.render).not.toHaveBeenCalled();
	});

	it('uses a generic parse error message for non-Error parse failures', async () => {
		mermaidMock.parse.mockRejectedValueOnce('not an error');

		render(<MermaidRenderer chart={'graph TD\nA-->'} theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Invalid mermaid syntax')).toBeInTheDocument();
		});
		expect(mermaidMock.render).not.toHaveBeenCalled();
	});

	it('reports an empty Mermaid render result', async () => {
		mermaidMock.render.mockResolvedValueOnce({ svg: '' });

		render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Mermaid returned empty result')).toBeInTheDocument();
		});
	});

	it('reports render failures and removes Mermaid-injected error nodes', async () => {
		const injectedError = document.createElement('div');
		injectedError.id = 'dmermaid-test-error';
		document.body.appendChild(injectedError);
		mermaidMock.render.mockRejectedValueOnce(new Error('render exploded'));

		render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.getByText('render exploded')).toBeInTheDocument();
		});

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Mermaid rendering error:',
			undefined,
			expect.any(Error)
		);
		expect(document.getElementById('dmermaid-test-error')).toBeNull();
	});

	it('uses a generic render error message for non-Error render failures', async () => {
		mermaidMock.render.mockRejectedValueOnce('render failed');

		render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.getByText('Failed to render diagram')).toBeInTheDocument();
		});

		expect(loggerMock.error).toHaveBeenCalledWith(
			'Mermaid rendering error:',
			undefined,
			'render failed'
		);
	});

	it('does not append sanitized content when Mermaid output is not an SVG element', async () => {
		mermaidMock.render.mockResolvedValueOnce({ svg: '<div>not svg</div>' });

		const { container } = render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={darkTheme} />);

		await waitFor(() => {
			expect(screen.queryByText('Rendering diagram...')).not.toBeInTheDocument();
		});

		expect(container.querySelector('.mermaid-container svg')).not.toBeInTheDocument();
		expect(screen.queryByText('Failed to render Mermaid diagram')).not.toBeInTheDocument();
	});

	it('does not report a parse error that settles after unmount', async () => {
		let rejectParse!: (error: Error) => void;
		mermaidMock.parse.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectParse = reject;
				})
		);

		const { unmount } = render(<MermaidRenderer chart={'graph TD\nA-->'} theme={darkTheme} />);
		unmount();

		await act(async () => {
			rejectParse(new Error('late parse failure'));
			await Promise.resolve();
		});

		expect(screen.queryByText('Failed to render Mermaid diagram')).not.toBeInTheDocument();
		expect(mermaidMock.render).not.toHaveBeenCalled();
	});

	it('does not append SVG for a render that resolves after unmount', async () => {
		let resolveRender!: (value: { svg: string }) => void;
		mermaidMock.render.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveRender = resolve;
				})
		);

		const { container, unmount } = render(
			<MermaidRenderer chart={'graph TD\nA-->B'} theme={darkTheme} />
		);
		await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());
		unmount();

		await act(async () => {
			resolveRender({ svg: '<svg><text>Late render</text></svg>' });
			await Promise.resolve();
		});

		expect(container.querySelector('svg')).not.toBeInTheDocument();
	});

	it('does not log render errors that reject after unmount', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		let rejectRender!: (error: Error) => void;
		mermaidMock.render.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectRender = reject;
				})
		);

		const { unmount } = render(<MermaidRenderer chart={'graph TD\nA-->B'} theme={darkTheme} />);
		await waitFor(() => expect(mermaidMock.render).toHaveBeenCalled());
		unmount();

		await act(async () => {
			rejectRender(new Error('late render failure'));
			await Promise.resolve();
		});

		expect(consoleError).not.toHaveBeenCalled();
	});

	it('renders a diagram whose SVG uses xlink:href without an xmlns:xlink declaration', async () => {
		// This mirrors Mermaid's C4 output: an <image xlink:href> without the
		// xmlns:xlink namespace declared on the root <svg>. A strict
		// image/svg+xml reparse rejects this (blank diagram) - the regression
		// this test guards. The renderer must parse it leniently and mount it.
		mermaidMock.render.mockResolvedValueOnce({
			svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-roledescription="c4"><image xlink:href="sprite.png" x="0" y="0"/><g/></svg>',
		});

		const { container } = render(<MermaidRenderer chart="C4Context" theme={darkTheme} />);

		await waitFor(() => {
			expect(container.querySelector('.mermaid-container svg')).not.toBeNull();
		});
		// The xlink:href element survives into the mounted DOM.
		expect(container.querySelector('.mermaid-container svg image')).not.toBeNull();
	});
});
