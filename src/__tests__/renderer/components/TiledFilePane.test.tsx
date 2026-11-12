import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TiledLayout } from '../../../renderer/components/MainPanel/TiledLayout';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { TabGroup, Theme } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

// Stand in for the real (lazy, mermaid-pulling) preview. Exposes the filename it was
// handed (FilePreview decides markdown vs source, image, CSV, and binary purely from
// `file.name`, so the filename IS the behavior under test) and records every prop so
// the pane's handler wiring can be asserted without the real preview stack.
const previewProps: Record<string, unknown>[] = [];
vi.mock('../../../renderer/components/FilePreview', () => ({
	FilePreview: (props: { file: { name: string } } & Record<string, unknown>) => {
		previewProps.push(props);
		return <div data-testid="preview-file-name">{props.file.name}</div>;
	},
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

/** One tiled file tab, `f1`, with scroll/search state and a two-entry visit history. */
function makeSession(tabOverrides: Record<string, unknown> = {}) {
	return createMockSession({
		id: 's1',
		fullPath: '/repo',
		filePreviewTabs: [
			{
				id: 'f1',
				name: 'README',
				extension: '.md',
				path: '/repo/README.md',
				content: '# Title',
				...tabOverrides,
			},
		] as never,
		activeFileTabId: 'f1',
	});
}

describe('tiled file pane', () => {
	beforeEach(() => {
		previewProps.length = 0;
		useSessionStore.getState().setSessions([]);
	});

	it('previews the file under its full name so markdown renders formatted, not as source', async () => {
		const session = makeSession();
		useSessionStore.getState().setSessions([session]);

		render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

		// Without the extension the pane would preview a file called "README", which
		// getLanguageFromFilename cannot recognize as markdown - the bug that left
		// tiled markdown stuck in the unformatted source view.
		await waitFor(() => {
			expect(screen.getByTestId('preview-file-name').textContent).toBe('README.md');
		});
	});

	it('wires file links, scroll memory, and find memory the single view has', async () => {
		const fileTree = [{ name: 'README.md', path: '/repo/README.md', type: 'file' }] as never;
		const onFileClick = vi.fn();
		const onFileTabScrollPositionChange = vi.fn();
		const onFileTabSearchQueryChange = vi.fn();
		const session = makeSession({ scrollTop: 240, searchQuery: 'needle' });
		useSessionStore.getState().setSessions([session]);

		render(
			<TiledLayout
				group={makeGroup()}
				session={session}
				theme={theme}
				paneFileActions={{
					fileTree,
					onFileClick,
					onFileTabScrollPositionChange,
					onFileTabSearchQueryChange,
				}}
			/>
		);

		await waitFor(() => expect(previewProps.length).toBeGreaterThan(0));
		const props = previewProps[previewProps.length - 1];
		// Without a tree + cwd a wiki link inside a tiled preview resolved to nothing.
		expect(props.fileTree).toBe(fileTree);
		expect(props.onFileClick).toBe(onFileClick);
		expect(props.initialScrollTop).toBe(240);
		expect(props.initialSearchQuery).toBe('needle');

		// Both persist against THIS pane's tab id, not the active file tab.
		(props.onScrollPositionChange as (v: number) => void)(99);
		(props.onSearchQueryChange as (v: string) => void)('other');
		expect(onFileTabScrollPositionChange).toHaveBeenCalledWith('f1', 99);
		expect(onFileTabSearchQueryChange).toHaveBeenCalledWith('f1', 'other');
	});

	it('drives breadcrumb navigation against its own tab id', async () => {
		const onFileTabNavigateToIndex = vi.fn();
		const session = makeSession({
			navigationHistory: [
				{ name: 'A', path: '/repo/a.md' },
				{ name: 'B', path: '/repo/b.md' },
				{ name: 'C', path: '/repo/c.md' },
			],
			navigationIndex: 1,
		});
		useSessionStore.getState().setSessions([session]);

		render(
			<TiledLayout
				group={makeGroup()}
				session={session}
				theme={theme}
				paneFileActions={{ onFileTabNavigateToIndex }}
			/>
		);

		await waitFor(() => expect(previewProps.length).toBeGreaterThan(0));
		const props = previewProps[previewProps.length - 1];
		expect(props.canGoBack).toBe(true);
		expect(props.canGoForward).toBe(true);
		expect(props.currentHistoryIndex).toBe(1);

		// Focusing a file pane does NOT set activeFileTabId, so an unaddressed
		// navigate would move whichever other file tab happened to be active.
		(props.onNavigateBack as () => void)();
		expect(onFileTabNavigateToIndex).toHaveBeenCalledWith(0, 'f1');
		(props.onNavigateForward as () => void)();
		expect(onFileTabNavigateToIndex).toHaveBeenCalledWith(2, 'f1');
	});
});
