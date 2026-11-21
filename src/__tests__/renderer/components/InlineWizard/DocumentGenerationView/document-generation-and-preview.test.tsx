// Source: src/__tests__/renderer/components/InlineWizard/DocumentGenerationView/CreatedFilesList.test.tsx
// Source: src/__tests__/renderer/components/InlineWizard/DocumentGenerationView/wrappers.test.tsx
// Source: src/__tests__/renderer/components/InlineWizard/StreamingDocumentPreview.test.tsx
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { CreatedFilesList } from '../../../../../renderer/components/InlineWizard/DocumentGenerationView/components';
import { mockTheme } from '../../../../helpers/mockTheme';
import { createRef } from 'react';
import { vi } from 'vitest';
import { DocumentEditor } from '../../../../../renderer/components/InlineWizard/DocumentGenerationView';
import { DocumentSelector } from '../../../../../renderer/components/InlineWizard/DocumentGenerationView';
import React from 'react';
import { beforeEach } from 'vitest';
import { StreamingDocumentPreview } from '../../../../../renderer/components/InlineWizard/StreamingDocumentPreview';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

vi.mock('../../../../../renderer/components/Wizard/shared/DocumentSelector', () => ({
	DocumentSelector: ({
		className,
		showTaskCounts,
		selectedIndex,
	}: {
		className?: string;
		showTaskCounts?: boolean;
		selectedIndex: number;
	}) => (
		<div
			data-testid="shared-selector"
			data-class-name={className}
			data-show-task-counts={String(showTaskCounts)}
			data-selected-index={selectedIndex}
		/>
	),
}));
vi.mock('../../../../../renderer/components/Wizard/shared/DocumentEditor', () => ({
	DocumentEditor: ({
		folderPath,
		selectedFile,
		showHeader,
		proseClassPrefix,
	}: {
		folderPath: string;
		selectedFile: string;
		showHeader: boolean;
		proseClassPrefix: string;
	}) => (
		<div
			data-testid="shared-editor"
			data-folder-path={folderPath}
			data-selected-file={selectedFile}
			data-show-header={String(showHeader)}
			data-prose-class-prefix={proseClassPrefix}
		/>
	),
}));
describe('CreatedFilesList', () => {
	const firstDoc = {
		filename: 'Phase-01-Setup.md',
		content: '# Setup\n\nFirst paragraph.\n\n- [ ] Task',
		taskCount: 1,
	};

	const secondDoc = {
		filename: 'Phase-02-Build.md',
		content: '# Build\n\nSecond paragraph.\n\n- [ ] Task',
		taskCount: 1,
	};

	function getDescriptionPanel(text: string): HTMLElement {
		const description = screen.getByText(text);
		const panel = description.parentElement;
		if (!panel) throw new Error('Missing description panel');
		return panel;
	}

	describe('CreatedFilesList', () => {
		it('auto-expands the newest file when it is added', () => {
			const { rerender } = render(<CreatedFilesList documents={[firstDoc]} theme={mockTheme} />);

			rerender(<CreatedFilesList documents={[firstDoc, secondDoc]} theme={mockTheme} />);

			expect(getDescriptionPanel('Second paragraph.')).toHaveStyle({ maxHeight: '120px' });
		});

		it('preserves a user-expanded file when a newer file appears', () => {
			const { rerender } = render(<CreatedFilesList documents={[firstDoc]} theme={mockTheme} />);

			fireEvent.click(screen.getByRole('button', { name: /phase-01-setup/i }));
			rerender(<CreatedFilesList documents={[firstDoc, secondDoc]} theme={mockTheme} />);

			expect(getDescriptionPanel('First paragraph.')).toHaveStyle({ maxHeight: '120px' });
			expect(getDescriptionPanel('Second paragraph.')).toHaveStyle({ maxHeight: '120px' });
		});
	});
});
describe('wrappers', () => {
	describe('DocumentGenerationView legacy wrappers', () => {
		it('delegates DocumentSelector to the shared selector with task counts enabled', () => {
			render(
				<DocumentSelector
					documents={[{ filename: 'Phase.md', content: '- [ ] Task', taskCount: 1 }]}
					selectedIndex={0}
					onSelect={vi.fn()}
					theme={mockTheme}
				/>
			);

			const selector = screen.getByTestId('shared-selector');
			expect(selector).toHaveAttribute('data-class-name', 'flex-1 min-w-0');
			expect(selector).toHaveAttribute('data-show-task-counts', 'true');
			expect(selector).toHaveAttribute('data-selected-index', '0');
		});

		it('delegates DocumentEditor to the shared editor with hidden header defaults', () => {
			render(
				<DocumentEditor
					content="# Plan"
					onContentChange={vi.fn()}
					mode="edit"
					onModeChange={vi.fn()}
					folderPath="/docs"
					selectedFile="Phase.md"
					attachments={[]}
					onAddAttachment={vi.fn()}
					onRemoveAttachment={vi.fn()}
					theme={mockTheme}
					isLocked={false}
					textareaRef={createRef<HTMLTextAreaElement>()}
					previewRef={createRef<HTMLDivElement>()}
				/>
			);

			const editor = screen.getByTestId('shared-editor');
			expect(editor).toHaveAttribute('data-folder-path', '/docs');
			expect(editor).toHaveAttribute('data-selected-file', 'Phase.md');
			expect(editor).toHaveAttribute('data-show-header', 'false');
			expect(editor).toHaveAttribute('data-prose-class-prefix', 'doc-gen-view');
		});
	});
});
describe('StreamingDocumentPreview', () => {
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
});
