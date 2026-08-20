import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoRun } from '../../../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * The Auto Run preview through the REAL markdown pipeline.
 *
 * The main AutoRun suite stubs `react-markdown` out, so it cannot tell a
 * callout from a blockquote or a live checkbox from a disabled one. Both of
 * those have already regressed once: the preview assembled its own remark stack
 * without `remarkAlert` (literal `[!WARNING]` markers), and react-markdown's
 * default `disabled` checkbox made preview a read-only surface even though the
 * prose styles gave the box a pointer cursor.
 */
vi.mock('../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: () => <div data-testid="mermaid" />,
}));

const writeDoc = vi.fn().mockResolvedValue(undefined);

const baseProps = (overrides: Record<string, unknown> = {}) => ({
	theme: mockTheme,
	sessionId: 'session-1',
	folderPath: '/test/folder',
	selectedFile: 'doc',
	documentList: ['doc'],
	content: '',
	onContentChange: vi.fn(),
	mode: 'preview' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

const renderPreview = (content: string, overrides: Record<string, unknown> = {}) =>
	render(
		<LayerStackProvider>
			<AutoRun {...(baseProps({ content, ...overrides }) as any)} />
		</LayerStackProvider>
	);

beforeEach(() => {
	writeDoc.mockClear();
	(window as any).maestro = {
		fs: { readFile: vi.fn().mockResolvedValue(''), readDir: vi.fn().mockResolvedValue([]) },
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			writeDoc,
		},
		settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
	};
});

describe('Auto Run preview callouts', () => {
	const ALERT_DOC =
		'> [!WARNING]\n> Not a playbook.\n\n> [!IMPORTANT]\n> Read this.\n\n> Just a quote.\n';

	it('renders `[!TYPE]` blockquotes as callouts instead of literal markers', () => {
		const { container } = renderPreview(ALERT_DOC);

		expect(screen.getByText('Warning')).toBeInTheDocument();
		expect(screen.getByText('Important')).toBeInTheDocument();
		expect(container.textContent).not.toContain('[!WARNING]');
		expect(container.textContent).not.toContain('[!IMPORTANT]');

		expect(
			Array.from(container.querySelectorAll('.markdown-alert')).map((el) =>
				el.getAttribute('data-alert-type')
			)
		).toEqual(['warning', 'important']);
	});

	it('leaves an ordinary blockquote alone', () => {
		const { container } = renderPreview(ALERT_DOC);

		expect(container.querySelectorAll('blockquote')).toHaveLength(1);
		expect(container.querySelector('blockquote')?.textContent).toContain('Just a quote.');
	});
});

describe('Auto Run preview task checkboxes', () => {
	const TASK_DOC = '# Doc\n\n- [ ] first\n- [x] second\n';

	it('writes the flipped task back to the document when a box is clicked', async () => {
		const { container } = renderPreview(TASK_DOC);
		const boxes = container.querySelectorAll('input[type="checkbox"]');

		expect(boxes).toHaveLength(2);
		fireEvent.click(boxes[0]);

		await waitFor(() =>
			expect(writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'doc.md',
				'# Doc\n\n- [x] first\n- [x] second\n',
				undefined
			)
		);
	});

	it('unchecks a completed task', async () => {
		const { container } = renderPreview(TASK_DOC);

		fireEvent.click(container.querySelectorAll('input[type="checkbox"]')[1]);

		await waitFor(() =>
			expect(writeDoc).toHaveBeenCalledWith(
				'/test/folder',
				'doc.md',
				'# Doc\n\n- [ ] first\n- [ ] second\n',
				undefined
			)
		);
	});

	// A document owned by a running Auto Run is read-only in the editor; its
	// checkboxes must match rather than letting a click race the agent.
	it('keeps checkboxes read-only while the document is locked by a run', () => {
		const { container } = renderPreview(TASK_DOC, {
			batchRunState: {
				isRunning: true,
				isStopping: false,
				documents: ['doc'],
				lockedDocuments: ['doc'],
				currentDocumentIndex: 0,
				worktreeActive: false,
				folderPath: '/test/folder',
				totalTasks: 2,
				completedTasks: 1,
				currentTaskIndex: 0,
				originalContent: '',
			},
		});

		const boxes = container.querySelectorAll('input[type="checkbox"]');
		expect(boxes).toHaveLength(2);
		expect((boxes[0] as HTMLInputElement).disabled).toBe(true);

		fireEvent.click(boxes[0]);
		expect(writeDoc).not.toHaveBeenCalled();
	});
});
