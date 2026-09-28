import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilePreview } from '../../../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { buildParquetPreviewMarker } from '../../../../shared/parquet/preview';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * FilePreview's routing for `.parquet` files.
 *
 * A parquet tab's `content` is a handoff marker, not the file - the real bytes
 * stay behind an open descriptor in the main process. That makes the ROUTING
 * the load-bearing part: every text branch below it would happily render the
 * marker as a line of source, and the binary branch would show an "Open
 * Externally" card for a file Maestro can display perfectly well.
 *
 * The ParquetViewer itself is stubbed here. It talks to `window.maestro.parquet`
 * and is covered by its own suite; what these tests pin down is that FilePreview
 * reaches it at all, and that nothing else claims the tab first.
 */
vi.mock('../../../../renderer/components/ParquetViewer', () => ({
	ParquetViewer: React.forwardRef<
		unknown,
		{ filePath: string; fileName: string; sshRemoteId?: string }
	>(function ParquetViewerStub({ filePath, fileName, sshRemoteId }, _ref) {
		return (
			<div
				data-testid="parquet-viewer-stub"
				data-file-path={filePath}
				data-file-name={fileName}
				data-ssh-remote-id={sshRemoteId ?? ''}
			/>
		);
	}),
}));

const MARKER = buildParquetPreviewMarker('/data/events.parquet');

function renderPreview(
	file: { name: string; content: string; path: string },
	extra: Record<string, unknown> = {}
) {
	return render(
		<LayerStackProvider>
			<FilePreview
				file={file}
				onClose={vi.fn()}
				theme={mockTheme}
				markdownEditMode={false}
				setMarkdownEditMode={vi.fn()}
				shortcuts={{}}
				{...extra}
			/>
		</LayerStackProvider>
	);
}

describe('FilePreview parquet routing', () => {
	it('routes a parquet marker to the ParquetViewer', () => {
		renderPreview({ name: 'events.parquet', content: MARKER, path: '/data/events.parquet' });

		const stub = screen.getByTestId('parquet-viewer-stub');
		expect(stub).toBeInTheDocument();
		expect(stub.getAttribute('data-file-path')).toBe('/data/events.parquet');
		expect(stub.getAttribute('data-file-name')).toBe('events.parquet');
	});

	it('never shows the marker text anywhere on screen', () => {
		// The failure this guards against is not a crash: it is a tab that looks
		// like it loaded and shows `maestro-parquet://preview/64617461...`.
		const { container } = renderPreview({
			name: 'events.parquet',
			content: MARKER,
			path: '/data/events.parquet',
		});

		expect(container.textContent).not.toContain('maestro-parquet');
	});

	it('does not fall through to the binary card', () => {
		renderPreview({ name: 'events.parquet', content: MARKER, path: '/data/events.parquet' });

		expect(screen.queryByText('Binary File')).not.toBeInTheDocument();
		expect(screen.queryByText(/cannot be displayed as text/)).not.toBeInTheDocument();
	});

	it('passes the SSH remote id through so a remote file resolves on the right host', () => {
		renderPreview(
			{ name: 'events.parquet', content: MARKER, path: '/remote/events.parquet' },
			{ sshRemoteId: 'remote-7' }
		);

		expect(screen.getByTestId('parquet-viewer-stub').getAttribute('data-ssh-remote-id')).toBe(
			'remote-7'
		);
	});

	it('leaves an ordinary text file alone', () => {
		// The marker check reads the CONTENT, not the filename, so a tab holding
		// real text must never be handed to a viewer that would ignore it.
		renderPreview({ name: 'notes.txt', content: 'plain text content', path: '/data/notes.txt' });

		expect(screen.queryByTestId('parquet-viewer-stub')).not.toBeInTheDocument();
		expect(screen.getByText(/plain text content/)).toBeInTheDocument();
	});

	it('does not route a file that merely has a parquet name but real content', () => {
		// Defensive: content is the authority. A `.parquet` tab restored from an
		// older build could hold text, and rendering it as a grid would lose it.
		renderPreview({
			name: 'events.parquet',
			content: 'id,name\n1,a\n',
			path: '/data/events.parquet',
		});

		expect(screen.queryByTestId('parquet-viewer-stub')).not.toBeInTheDocument();
	});
});
