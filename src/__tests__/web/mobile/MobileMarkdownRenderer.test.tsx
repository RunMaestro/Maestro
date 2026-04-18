/**
 * Tests for MobileMarkdownRenderer component
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MobileMarkdownRenderer } from '../../../web/mobile/MobileMarkdownRenderer';

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		accent: '#8b5cf6',
		border: '#374151',
		bgActivity: '#1f2937',
		textMain: '#f3f4f6',
		textDim: '#9ca3af',
		success: '#22c55e',
	}),
	useTheme: () => ({ isDark: true }),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		success: [10, 50, 10],
		error: [50, 50, 50],
	},
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

describe('MobileMarkdownRenderer', () => {
	it('applies Bionify emphasis to prose when enabled', () => {
		const { container } = render(
			<MobileMarkdownRenderer
				content="Reading mode improves prose."
				enableBionifyReadingMode={true}
			/>
		);

		expect(container.querySelector('.bionify-word-emphasis')).toBeInTheDocument();
	});

	it('leaves prose unchanged when disabled', () => {
		const { container } = render(
			<MobileMarkdownRenderer
				content="Reading mode stays plain."
				enableBionifyReadingMode={false}
			/>
		);

		expect(container.querySelector('.bionify-word-emphasis')).toBeNull();
	});

	it('does not bionify fenced code blocks', () => {
		const { container, getByTestId } = render(
			<MobileMarkdownRenderer
				content={'Intro text\n```ts\nconst value = 1;\n```'}
				enableBionifyReadingMode={true}
			/>
		);

		expect(container.querySelector('.bionify-word-emphasis')).toBeInTheDocument();
		expect(getByTestId('syntax-highlighter').querySelector('.bionify-word-emphasis')).toBeNull();
	});
});
