import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Task-checkbox editing exercised through the REAL markdown pipeline.
 *
 * The main FilePreview suite stubs `react-markdown` out entirely, so it cannot
 * see a checkbox at all. This file leaves remark/rehype intact - the whole
 * point is that remark-gfm renders the box, `rehypeSourceLine` stamps it with
 * its source line, and a click turns that line back into a file write.
 */
vi.mock('../../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<unknown, { value: string; onChange: (v: string) => void }>(
		({ value, onChange }, _ref) => (
			<textarea value={value} onChange={(e) => onChange(e.target.value)} />
		)
	),
}));

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
