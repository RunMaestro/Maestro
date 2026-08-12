import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TiledLayout } from '../../../renderer/components/MainPanel/TiledLayout';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { TabGroup, Theme } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

// Stand in for the real (lazy, mermaid-pulling) preview and expose the filename it
// was handed. FilePreview decides markdown vs source, image, CSV, and binary purely
// from `file.name`, so the filename IS the behavior under test here.
vi.mock('../../../renderer/components/FilePreview', () => ({
	FilePreview: ({ file }: { file: { name: string } }) => (
		<div data-testid="preview-file-name">{file.name}</div>
	),
}));

const theme = {
	colors: { accent: '#89b4fa', bgMain: '#1e1e2e', border: '#313244', textDim: '#6c7086' },
} as unknown as Theme;

function makeGroup(): TabGroup {
	return {
		id: 'g1',
		name: 'Group',
		layout: { kind: 'leaf', id: 'leaf-1', tab: { type: 'file', id: 'f1' } },
		focusedPaneId: 'leaf-1',
		createdAt: 0,
	};
}

describe('tiled file pane', () => {
	beforeEach(() => {
		useSessionStore.getState().setSessions([]);
	});

	it('previews the file under its full name so markdown renders formatted, not as source', async () => {
		const session = createMockSession({
			id: 's1',
			filePreviewTabs: [
				{
					id: 'f1',
					name: 'README',
					extension: '.md',
					path: '/repo/README.md',
					content: '# Title',
				},
			] as never,
			activeFileTabId: 'f1',
		});
		useSessionStore.getState().setSessions([session]);

		render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

		// Without the extension the pane would preview a file called "README", which
		// getLanguageFromFilename cannot recognize as markdown - the bug that left
		// tiled markdown stuck in the unformatted source view.
		await waitFor(() => {
			expect(screen.getByTestId('preview-file-name').textContent).toBe('README.md');
		});
	});
});
