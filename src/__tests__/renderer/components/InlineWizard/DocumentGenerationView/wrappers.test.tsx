import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mockTheme } from '../../../../helpers/mockTheme';

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

import {
	DocumentEditor,
	DocumentSelector,
} from '../../../../../renderer/components/InlineWizard/DocumentGenerationView';

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
