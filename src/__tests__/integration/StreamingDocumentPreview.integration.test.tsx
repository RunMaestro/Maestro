import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StreamingDocumentPreview } from '../../renderer/components/InlineWizard/StreamingDocumentPreview';
import { useSettingsStore } from '../../renderer/stores/settingsStore';

const mockTheme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#202020',
		textMain: '#f5f5f5',
		textDim: '#9a9a9a',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		border: '#303030',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as const;

describe('StreamingDocumentPreview', () => {
	const openExternalMock = vi.fn();

	beforeEach(() => {
		useSettingsStore.setState({ bionifyReadingMode: false });
		openExternalMock.mockReset();
		window.maestro.shell.openExternal = openExternalMock;
	});

	it('applies reading mode in markdown preview without mutating links or code', () => {
		useSettingsStore.setState({ bionifyReadingMode: true });

		render(
			<StreamingDocumentPreview
				theme={mockTheme}
				filename="draft.md"
				content={'Hello `code sample` [example link](https://example.com) world'}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Preview/i }));

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(screen.getByText('code sample')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'example link' })).toBeInTheDocument();
		expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
	});

	it('disables markdown preview while a code block is still streaming', () => {
		render(
			<StreamingDocumentPreview
				theme={mockTheme}
				filename="draft.md"
				content={'```ts\nconst value = 1;'}
			/>
		);

		const previewButton = screen.getByRole('button', { name: /Preview/i });

		expect(previewButton).toBeDisabled();
		expect(previewButton).toHaveAttribute(
			'title',
			'Markdown preview unavailable (code block in progress)'
		);
	});

	it('repairs incomplete links for preview and routes external clicks through the shell bridge', () => {
		render(
			<StreamingDocumentPreview
				theme={mockTheme}
				filename="draft.md"
				content={'Read [the docs](https://example.com/docs'}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /Preview/i }));
		fireEvent.click(screen.getByRole('link', { name: 'the docs' }));

		expect(openExternalMock).toHaveBeenCalledWith('https://example.com/docs');

		fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
		expect(screen.getByText('Read [the docs](https://example.com/docs')).toBeInTheDocument();
	});

	it('shows fallback filename and phase progress when metadata is partial', () => {
		render(
			<StreamingDocumentPreview
				theme={mockTheme}
				content="Streaming content"
				currentPhase={2}
				totalPhases={3}
			/>
		);

		expect(screen.getByText('Generating...')).toBeInTheDocument();
		expect(screen.getByText('Generating Phase 2 of 3...')).toBeInTheDocument();
	});

	it('tracks manual scrolling, resumes auto-scroll, and resets the indicator when the filename changes', () => {
		const { rerender } = render(
			<StreamingDocumentPreview theme={mockTheme} filename="draft.md" content="First draft" />
		);
		const scrollContainer = document.querySelector('.overflow-y-auto') as HTMLDivElement;

		Object.defineProperty(scrollContainer, 'scrollHeight', {
			value: 240,
			configurable: true,
		});
		Object.defineProperty(scrollContainer, 'clientHeight', {
			value: 100,
			configurable: true,
		});
		Object.defineProperty(scrollContainer, 'scrollTop', {
			value: 20,
			writable: true,
			configurable: true,
		});

		fireEvent.scroll(scrollContainer);
		expect(screen.getByRole('button', { name: /Resume auto-scroll/i })).toBeInTheDocument();

		rerender(
			<StreamingDocumentPreview theme={mockTheme} filename="draft.md" content="Updated draft" />
		);
		fireEvent.scroll(scrollContainer);
		expect(screen.getByRole('button', { name: /Resume auto-scroll/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Resume auto-scroll/i }));
		expect(scrollContainer.scrollTop).toBe(240);
		expect(screen.queryByRole('button', { name: /Resume auto-scroll/i })).not.toBeInTheDocument();

		Object.defineProperty(scrollContainer, 'scrollTop', {
			value: 20,
			writable: true,
			configurable: true,
		});
		fireEvent.scroll(scrollContainer);
		expect(screen.getByRole('button', { name: /Resume auto-scroll/i })).toBeInTheDocument();

		rerender(
			<StreamingDocumentPreview theme={mockTheme} filename="next.md" content="Next draft" />
		);

		expect(screen.queryByRole('button', { name: /Resume auto-scroll/i })).not.toBeInTheDocument();

		rerender(<StreamingDocumentPreview theme={mockTheme} content="Untitled draft" />);

		expect(screen.getByText('Generating...')).toBeInTheDocument();
	});
});
