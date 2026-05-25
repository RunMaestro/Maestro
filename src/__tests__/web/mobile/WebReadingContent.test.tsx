import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WebReadingContent } from '../../../web/mobile/WebReadingContent';

const themeState = vi.hoisted(() => ({
	isDark: true,
}));

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgActivity: '#1f2937',
		border: '#374151',
		success: '#22c55e',
		textDim: '#9ca3af',
		textMain: '#f3f4f6',
	}),
	useTheme: () => ({ isDark: themeState.isDark }),
}));

vi.mock('../../../web/mobile/constants', () => ({
	HAPTIC_PATTERNS: {
		success: [10],
		error: [50],
	},
	triggerHaptic: vi.fn(),
}));

vi.mock('../../../web/utils/logger', () => ({
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

describe('WebReadingContent', () => {
	beforeEach(() => {
		themeState.isDark = true;
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
});
