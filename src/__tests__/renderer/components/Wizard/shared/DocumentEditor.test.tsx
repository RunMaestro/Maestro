import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DocumentEditor } from '../../../../../renderer/components/Wizard/shared/DocumentEditor';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

vi.mock('../../../../../renderer/components/Wizard/shared/DocumentSelector', () => ({
	DocumentSelector: ({ selectedIndex }: { selectedIndex: number }) => (
		<div data-testid="document-selector">Selected {selectedIndex}</div>
	),
}));

vi.mock('../../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

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

const defaultProps = {
	content: 'Hello `code sample` [example link](https://example.com) world',
	onContentChange: vi.fn(),
	mode: 'preview' as const,
	onModeChange: vi.fn(),
	folderPath: '/tmp/autorun',
	selectedFile: 'draft',
	attachments: [],
	onAddAttachment: vi.fn(),
	onRemoveAttachment: vi.fn(),
	theme: mockTheme,
	isLocked: false,
	textareaRef: { current: null },
	previewRef: { current: null },
	documents: [{ filename: 'draft.md', content: '# Draft', taskCount: 1 }],
	selectedDocIndex: 0,
	onDocumentSelect: vi.fn(),
	statsText: '1 task ready to run',
};

describe('DocumentEditor', () => {
	beforeEach(() => {
		useSettingsStore.setState({ bionifyReadingMode: false });
	});

	it('applies reading mode in preview while leaving links and code untouched', () => {
		useSettingsStore.setState({ bionifyReadingMode: true });

		render(<DocumentEditor {...defaultProps} />);

		expect(document.querySelectorAll('.bionify-word').length).toBeGreaterThan(0);
		expect(screen.getByText('code sample')).toBeInTheDocument();
		expect(screen.getByRole('link', { name: 'example link' })).toBeInTheDocument();
		expect(document.querySelector('code .bionify-word')).not.toBeInTheDocument();
		expect(document.querySelector('a .bionify-word')).not.toBeInTheDocument();
	});
});
