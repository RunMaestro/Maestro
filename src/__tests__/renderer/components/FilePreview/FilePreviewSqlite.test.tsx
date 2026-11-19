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
 * marker, not as content. Until the SQLite viewer lands, that tab belongs on
 * the binary card, exactly where the raw bytes landed before. The marker is
 * pure ASCII, so without an explicit route every text branch would render it
 * as a line of editable source, most visibly on `.db3` / `.s3db` / `.sl3`,
 * which are not binary extensions.
 */
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
		'shows the binary card for a %s marker, never the marker text',
		(name) => {
			const path = `/data/${name}`;
			const { container } = renderPreview({
				name,
				content: buildSqlitePreviewMarker(path),
				path,
			});

			expect(screen.getByText('Binary File')).toBeInTheDocument();
			expect(container.textContent).not.toContain('maestro-sqlite');
		}
	);
});
