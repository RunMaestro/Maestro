import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { WebReadingContent } from '../../web/mobile/WebReadingContent';

const themeState = vi.hoisted(() => ({
	isDark: true,
}));

vi.mock('../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgActivity: '#1f2937',
		border: '#374151',
		success: '#22c55e',
		textDim: '#9ca3af',
		textMain: '#f3f4f6',
	}),
	useTheme: () => ({ isDark: themeState.isDark }),
}));

vi.mock('../../web/mobile/constants', () => ({
	HAPTIC_PATTERNS: {
		success: [10],
		error: [50],
	},
	triggerHaptic: vi.fn(),
}));

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		error: vi.fn(),
	},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children, language }: { children: string; language: string }) => (
		<pre data-testid="syntax-highlighter" data-language={language}>
			{children}
		</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: { name: 'dark' },
	vs: { name: 'light' },
}));

vi.mock('../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: ({
		content,
		fontSize,
		enableBionifyReadingMode,
	}: {
		content: string;
		fontSize: number;
		enableBionifyReadingMode: boolean;
	}) => (
		<div
			data-testid="markdown-renderer"
			data-font-size={fontSize}
			data-bionify={enableBionifyReadingMode}
		>
			{content}
		</div>
	),
}));

describe('WebReadingContent', () => {
	beforeEach(() => {
		themeState.isDark = true;
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('renders code blocks with text language fallback', () => {
		render(<WebReadingContent content={[{ type: 'code', content: 'plain code' }]} />);

		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-language', 'text');
		expect(screen.getByText('code')).toBeInTheDocument();
	});

	it('uses the light-mode Bionify rest opacity for prose segments', () => {
		themeState.isDark = false;
		render(
			<WebReadingContent
				enableBionifyReadingMode={true}
				content={[{ type: 'text', content: 'Readable prose content.' }]}
			/>
		);

		expect(document.querySelector('.bionify-text-block')).toHaveStyle({
			'--bionify-rest-opacity': '0.9',
		});
	});

	it('uses the dark-mode Bionify rest opacity for prose segments', () => {
		render(
			<WebReadingContent
				enableBionifyReadingMode={true}
				content={[{ type: 'text', content: 'Readable dark prose.' }]}
			/>
		);

		expect(document.querySelector('.bionify-text-block')).toHaveStyle({
			'--bionify-rest-opacity': '0.96',
		});
	});

	it('routes markdown content to the mobile markdown renderer', () => {
		render(<WebReadingContent content="# Heading" fontSize={16} enableBionifyReadingMode={true} />);

		expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('# Heading');
		expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-font-size', '16');
		expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-bionify', 'true');
	});

	it('copies language-specific code and resets the copied state', async () => {
		themeState.isDark = false;
		render(
			<WebReadingContent
				content={[{ type: 'code', content: 'const value = 1;', language: 'typescript' }]}
				codeBackgroundColor="#111827"
				codeBorderColor="#1f2937"
				codeSuccessColor="#10b981"
				logContext="ReaderTest"
			/>
		);

		expect(screen.getByText('typescript')).toBeInTheDocument();
		expect(screen.getByTestId('syntax-highlighter')).toHaveAttribute('data-language', 'typescript');

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
		});

		expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const value = 1;');
		expect(screen.getByRole('button', { name: 'Copied!' })).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(2000);
		});

		expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument();
	});

	it('logs and haptics copy failures', async () => {
		const { webLogger } = await import('../../web/utils/logger');
		const { triggerHaptic, HAPTIC_PATTERNS } = await import('../../web/mobile/constants');
		(navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('denied')
		);

		render(
			<WebReadingContent content={[{ type: 'code', content: 'blocked', language: 'text' }]} />
		);

		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
		});

		expect(webLogger.error).toHaveBeenCalledWith(
			'Failed to copy code',
			'WebReadingContent',
			expect.any(Error)
		);
		expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.error);
	});
});
