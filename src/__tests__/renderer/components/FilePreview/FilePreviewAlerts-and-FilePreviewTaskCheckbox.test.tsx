// Source: src/__tests__/renderer/components/FilePreview/FilePreviewAlerts.test.tsx
// Source: src/__tests__/renderer/components/FilePreview/FilePreviewTaskCheckbox.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import React from 'react';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';
import { beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
vi.mock('../../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<unknown, { value: string; onChange: (v: string) => void }>(
		({ value, onChange }, _ref) => (
			<textarea value={value} onChange={(e) => onChange(e.target.value)} />
		)
	),
}));
describeSourceSuite('FilePreviewAlerts', () => {
	const ALERT_DOC =
		'## Notes\n\n> [!IMPORTANT]\n> The only thing that matters.\n\n> [!WARNING]\n> Mind the gap.\n\n> Just a quote.\n';

	const renderPreview = (content: string) =>
		render(
			<LayerStackProvider>
				<FilePreview
					file={{ name: 'notes.md', content, path: '/test/notes.md' }}
					onClose={vi.fn()}
					theme={mockTheme}
					markdownEditMode={false}
					setMarkdownEditMode={vi.fn()}
					shortcuts={{}}
				/>
			</LayerStackProvider>
		);

	describe('FilePreview alert callouts', () => {
		it('renders `[!TYPE]` blockquotes as callouts instead of literal markers', () => {
			const { container } = renderPreview(ALERT_DOC);

			expect(screen.getByText('Important')).toBeInTheDocument();
			expect(screen.getByText('Warning')).toBeInTheDocument();
			expect(container.textContent).not.toContain('[!IMPORTANT]');
			expect(container.textContent).not.toContain('[!WARNING]');

			const callouts = container.querySelectorAll('.markdown-alert');
			expect(Array.from(callouts).map((el) => el.getAttribute('data-alert-type'))).toEqual([
				'important',
				'warning',
			]);
		});

		it('leaves an ordinary blockquote alone', () => {
			const { container } = renderPreview(ALERT_DOC);

			expect(container.querySelectorAll('blockquote')).toHaveLength(1);
			expect(container.querySelector('blockquote')?.textContent).toContain('Just a quote.');
		});
	});
});
describeSourceSuite('FilePreviewTaskCheckbox', () => {
	const TASK_DOC = '# Reminders\n\n- [ ] call the clerk\n- [x] pay the tier\n';

	const taskFile = { name: 'todo.md', content: TASK_DOC, path: '/test/todo.md' };

	const defaultProps = {
		file: taskFile,
		onClose: vi.fn(),
		theme: mockTheme,
		markdownEditMode: false,
		setMarkdownEditMode: vi.fn(),
		shortcuts: {},
	};

	const boxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

	const renderPreview = (props: Record<string, unknown> = {}) =>
		render(
			<LayerStackProvider>
				<FilePreview {...defaultProps} {...(props as any)} />
			</LayerStackProvider>
		);

	describe('FilePreview task checkboxes', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('renders them enabled when the file can be saved', () => {
			renderPreview({ onSave: vi.fn() });

			expect(boxes()).toHaveLength(2);
			expect(boxes().map((b) => b.checked)).toEqual([false, true]);
			expect(boxes().some((b) => b.disabled)).toBe(false);
		});

		it('leaves them read-only when there is no save handler', () => {
			renderPreview();

			expect(boxes().every((b) => b.disabled)).toBe(true);
		});

		it('writes the ticked line back to disk', async () => {
			const onSave = vi.fn().mockResolvedValue(true);
			renderPreview({ onSave });

			fireEvent.click(boxes()[0]);

			await waitFor(() =>
				expect(onSave).toHaveBeenCalledWith(
					'/test/todo.md',
					'# Reminders\n\n- [x] call the clerk\n- [x] pay the tier\n'
				)
			);
		});

		it('unticks a completed task', async () => {
			const onSave = vi.fn().mockResolvedValue(true);
			renderPreview({ onSave });

			fireEvent.click(boxes()[1]);

			await waitFor(() =>
				expect(onSave).toHaveBeenCalledWith(
					'/test/todo.md',
					'# Reminders\n\n- [ ] call the clerk\n- [ ] pay the tier\n'
				)
			);
		});

		it('builds the second write on the first, not on the not-yet-reloaded file', async () => {
			const onSave = vi.fn().mockResolvedValue(true);
			renderPreview({ onSave });

			fireEvent.click(boxes()[0]);
			await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
			fireEvent.click(boxes()[1]);

			await waitFor(() =>
				expect(onSave).toHaveBeenLastCalledWith(
					'/test/todo.md',
					'# Reminders\n\n- [x] call the clerk\n- [ ] pay the tier\n'
				)
			);
		});

		it('refuses to write over unsaved editor changes', async () => {
			const onSave = vi.fn().mockResolvedValue(true);
			renderPreview({
				onSave,
				externalEditContent: `${TASK_DOC}- [ ] a line only in the editor\n`,
			});

			fireEvent.click(boxes()[0]);

			await waitFor(() => expect(boxes()[0].checked).toBe(false));
			expect(onSave).not.toHaveBeenCalled();
		});
	});

	/**
	 * Ticking a box must not move the page.
	 *
	 * `createMarkdownComponents()` returns a map of freshly-created component
	 * functions, so rebuilding it hands React a NEW component TYPE for every
	 * element and it unmounts and remounts the entire rendered document. The
	 * scroll container survives, its contents do not, so the reader is thrown back
	 * to the top of a long file on every click. Both the toggle handler and the
	 * memo's old `file` dependency changed whenever the content did, which is
	 * exactly what rebuilt that map.
	 *
	 * jsdom has no layout engine, so asserting on `scrollTop` would pass either
	 * way. Asserting that the DOM nodes SURVIVE the toggle is the real invariant -
	 * a preserved node cannot have had its scroll position reset.
	 */
	describe('FilePreview stability across a task toggle', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('keeps the rendered document mounted when a task is ticked', async () => {
			const onSave = vi.fn().mockResolvedValue(true);
			const { container, rerender } = render(
				<LayerStackProvider>
					<FilePreview {...defaultProps} onSave={onSave} />
				</LayerStackProvider>
			);

			const headingBefore = container.querySelector('h1');
			const listBefore = container.querySelector('ul');
			expect(headingBefore).not.toBeNull();

			fireEvent.click(boxes()[0]);
			await waitFor(() => expect(onSave).toHaveBeenCalled());

			// The tab re-reads the file after the write and hands down a NEW file
			// object. That is the render the old dependency list tore the document
			// down on, so the assertion only means something after it.
			const saved = onSave.mock.calls[0][1] as string;
			rerender(
				<LayerStackProvider>
					<FilePreview {...defaultProps} file={{ ...taskFile, content: saved }} onSave={onSave} />
				</LayerStackProvider>
			);

			expect(container.querySelector('h1')).toBe(headingBefore);
			expect(container.querySelector('ul')).toBe(listBefore);
			expect(boxes().map((b) => b.checked)).toEqual([true, true]);
		});
	});
});
