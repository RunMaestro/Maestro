import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { buildSqlitePreviewMarker } from '../../../../shared/sqlite/preview';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * FilePreview's routing for a SQLite marker.
 *
 * `fs:readFile` hands a proven SQLite database back as a `maestro-sqlite://`
 * marker, not as content, and FilePreview must hand that tab to the
 * SqliteViewer. The marker is pure ASCII and `.db` / `.sqlite` are binary
 * extensions, so a missed route shows either the marker as editable text or
 * the binary card for a file Maestro can display.
 *
 * The viewer itself is stubbed: it talks to `window.maestro.sqlite` and has its
 * own suite. These tests pin down that FilePreview reaches it, and that a `.db`
 * whose content is NOT a marker (it failed the header sniff) keeps the binary
 * card.
 */
vi.mock('../../../../renderer/components/SqliteViewer', () => ({
	SqliteViewer: ({ filePath, fileName }: { filePath: string; fileName: string }) => (
		<div data-testid="sqlite-viewer-stub" data-file-path={filePath} data-file-name={fileName} />
	),
}));

function renderPreview(file: { name: string; content: string; path: string }) {
	return render(
		<LayerStackProvider>
			<FilePreview
				file={file}
				onClose={vi.fn()}
				theme={mockTheme}
				markdownEditMode={false}
				setMarkdownEditMode={vi.fn()}
				shortcuts={{}}
			/>
		</LayerStackProvider>
	);
}

describe('FilePreview SQLite routing', () => {
	it.each(['app.db', 'app.sqlite', 'app.db3', 'app.s3db', 'app.sl3'])(
		'hands a %s marker to the SQLite viewer, never as text or the binary card',
		(name) => {
			const path = `/data/${name}`;
			const { container } = renderPreview({
				name,
				content: buildSqlitePreviewMarker(path),
				path,
			});

			const stub = screen.getByTestId('sqlite-viewer-stub');
			expect(stub).toHaveAttribute('data-file-path', path);
			expect(stub).toHaveAttribute('data-file-name', name);
			expect(screen.queryByText('Binary File')).not.toBeInTheDocument();
			expect(container.textContent).not.toContain('maestro-sqlite');
		}
	);

	it('keeps a .db that is not SQLite on the binary card', () => {
		renderPreview({
			name: 'cache.db',
			content: '\u0000\u0001\u0002binary',
			path: '/data/cache.db',
		});
		expect(screen.getByText('Binary File')).toBeInTheDocument();
		expect(screen.queryByTestId('sqlite-viewer-stub')).not.toBeInTheDocument();
	});
});
