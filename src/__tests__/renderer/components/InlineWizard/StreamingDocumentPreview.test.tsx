import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StreamingDocumentPreview } from '../../../../renderer/components/InlineWizard/StreamingDocumentPreview';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

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
	beforeEach(() => {
		useSettingsStore.setState({ bionifyReadingMode: false });
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
});
