import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * GitHub `[!NOTE]`-style callouts through the REAL markdown pipeline.
 *
 * The main FilePreview suite stubs `react-markdown` out, so it cannot tell a
 * callout from a blockquote. FilePreview used to assemble its own remark stack
 * without `remarkAlert`, which left the raw `[!IMPORTANT]` marker as literal
 * text in the preview while chat rendered the same file as a styled callout.
 */
vi.mock('../../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<unknown, { value: string; onChange: (v: string) => void }>(
		({ value, onChange }, _ref) => (
			<textarea value={value} onChange={(e) => onChange(e.target.value)} />
		)
	),
}));

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
