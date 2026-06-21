import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GitLogViewer } from '../../renderer/components/GitLogViewer';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		textInverse: '#111827',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		border: '#3f3f46',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
		info: '#38bdf8',
	},
};

const today = new Date();
const yesterday = new Date(today);
yesterday.setDate(today.getDate() - 1);

const entries = [
	{
		hash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		shortHash: 'aaaaaaa',
		author: 'Ada',
		date: today.toISOString(),
		refs: ['HEAD -> main', 'origin/main', 'tag: v1.0.0'],
		subject: 'Add renderer integration',
		additions: 2,
		deletions: 1,
	},
	{
		hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		shortHash: 'bbbbbbb',
		author: 'Grace',
		date: yesterday.toISOString(),
		refs: [],
		subject: 'Fix loading state',
		additions: 0,
		deletions: 0,
	},
	{
		hash: 'cccccccccccccccccccccccccccccccccccccccc',
		shortHash: 'ccccccc',
		author: 'Linus',
		date: '2025-11-25T12:00:00.000Z',
		refs: ['feature/git-log'],
		subject: 'Document old history',
		additions: 10,
		deletions: 4,
	},
];

function showOutput(subject: string, file = 'src/file.ts') {
	return `commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
Author: Ada <ada@example.com>
Date:   ${today.toISOString()}

    ${subject}

    Body line one
    Body line two

---
 ${file} | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/${file} b/${file}
index 1111111..2222222 100644
--- a/${file}
+++ b/${file}
@@ -1,2 +1,2 @@
-old line
+new line
 keep line
`;
}

function renderViewer(overrides: Partial<React.ComponentProps<typeof GitLogViewer>> = {}) {
	const props = {
		cwd: '/workspace/app',
		theme,
		onClose: vi.fn(),
		...overrides,
	};
	const result = render(
		<LayerStackProvider>
			<GitLogViewer {...props} />
		</LayerStackProvider>
	);
	return { ...result, props };
}

describe('GitLogViewer integration', () => {
	beforeEach(() => {
		vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
		vi.mocked(window.maestro.git.log).mockResolvedValue({ entries, error: undefined });
		vi.mocked(window.maestro.git.commitCount).mockResolvedValue({ count: 250, error: null });
		vi.mocked(window.maestro.git.show).mockImplementation(async (_cwd, hash) => {
			if (hash === entries[1].hash)
				return { stdout: showOutput('Fix loading state', 'src/loading.ts') };
			if (hash === entries[2].hash) return { stdout: 'commit ccc\nDate: bad\n\n    No diff body' };
			return { stdout: showOutput('Add renderer integration') };
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('loads git history, count metadata, refs, commit body, stats, and parsed diff', async () => {
		renderViewer();

		expect(screen.getByText('Loading git log...')).toBeInTheDocument();
		expect(await screen.findAllByText('Add renderer integration')).toHaveLength(2);
		expect(screen.getByText('/workspace/app')).toBeInTheDocument();
		expect(screen.getByText('3 of 250 commits')).toBeInTheDocument();
		expect(screen.getByText('main')).toBeInTheDocument();
		expect(screen.getByText('origin/main')).toBeInTheDocument();
		expect(screen.getByText('v1.0.0')).toBeInTheDocument();
		expect(screen.getByText('+2')).toBeInTheDocument();
		expect(screen.getByText('-1')).toBeInTheDocument();

		expect(await screen.findByText(/Body line one/)).toBeInTheDocument();
		expect(screen.getByText('src/file.ts')).toBeInTheDocument();
		expect(screen.getByText('src/file.ts | 2 +-')).toBeInTheDocument();
		expect(window.maestro.git.log).toHaveBeenCalledWith(
			'/workspace/app',
			{ limit: 200 },
			undefined
		);
		expect(window.maestro.git.commitCount).toHaveBeenCalledWith('/workspace/app', undefined);
		expect(window.maestro.git.show).toHaveBeenCalledWith(
			'/workspace/app',
			entries[0].hash,
			undefined
		);
	});

	it('navigates with global keyboard shortcuts, click selection, and handles no-diff commits', async () => {
		renderViewer();
		await screen.findAllByText('Add renderer integration');

		await act(async () => {
			fireEvent.keyDown(window, { key: 'ArrowDown' });
		});
		expect(await screen.findByText('src/loading.ts')).toBeInTheDocument();
		expect(screen.getByText('Commit 2 of 3')).toBeInTheDocument();
		expect(screen.getByText(/Yesterday/)).toBeInTheDocument();

		await act(async () => {
			fireEvent.keyDown(window, { key: 'j' });
		});
		await waitFor(() => {
			expect(window.maestro.git.show).toHaveBeenLastCalledWith(
				'/workspace/app',
				entries[2].hash,
				undefined
			);
		});
		expect(await screen.findByText('No diff available for this commit')).toBeInTheDocument();
		expect(screen.getByText('Nov 25, 2025')).toBeInTheDocument();

		const addRendererListItem = screen
			.getAllByText('Add renderer integration')
			.find((element) => element.tagName === 'P');
		expect(addRendererListItem).toBeDefined();
		await act(async () => {
			fireEvent.click(addRendererListItem!);
		});
		expect(await screen.findByText('src/file.ts')).toBeInTheDocument();
		await act(async () => {
			fireEvent.keyDown(window, { key: 'PageDown' });
		});
		expect(await screen.findByText('Commit 3 of 3')).toBeInTheDocument();
		await act(async () => {
			fireEvent.keyDown(window, { key: 'k' });
		});
		expect(await screen.findByText('Commit 2 of 3')).toBeInTheDocument();
	});

	it('closes from button, overlay, and layer Escape using the latest callback', async () => {
		const { props, rerender } = renderViewer();
		await screen.findAllByText('Add renderer integration');

		fireEvent.click(screen.getByRole('button', { name: 'Close (Esc)' }));
		expect(props.onClose).toHaveBeenCalledOnce();

		const newOnClose = vi.fn();
		rerender(
			<LayerStackProvider>
				<GitLogViewer cwd="/workspace/app" theme={theme} onClose={newOnClose} />
			</LayerStackProvider>
		);
		await screen.findAllByText('Add renderer integration');
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(newOnClose).toHaveBeenCalledOnce());

		fireEvent.click(screen.getByRole('dialog', { name: 'Git Log Viewer' }).parentElement!);
		expect(newOnClose).toHaveBeenCalledTimes(2);
	});

	it('renders empty and error states and tolerates diff load failures', async () => {
		vi.mocked(window.maestro.git.log).mockResolvedValueOnce({ entries: [], error: undefined });
		vi.mocked(window.maestro.git.commitCount).mockResolvedValueOnce({ count: 0, error: 'ignored' });
		const { rerender } = renderViewer();
		expect(await screen.findByText('No commits found')).toBeInTheDocument();
		expect(screen.getByText('0 commits')).toBeInTheDocument();

		vi.mocked(window.maestro.git.log).mockResolvedValueOnce({
			entries: [],
			error: 'not a git repository',
		});
		rerender(
			<LayerStackProvider>
				<GitLogViewer cwd="/workspace/other" theme={theme} onClose={vi.fn()} />
			</LayerStackProvider>
		);
		expect(await screen.findByText('not a git repository')).toBeInTheDocument();

		vi.mocked(window.maestro.git.log).mockResolvedValueOnce({
			entries: [entries[0]],
			error: undefined,
		});
		vi.mocked(window.maestro.git.commitCount).mockResolvedValueOnce({ count: 1, error: null });
		vi.mocked(window.maestro.git.show).mockRejectedValueOnce(new Error('show failed'));
		rerender(
			<LayerStackProvider>
				<GitLogViewer
					cwd="/workspace/failure"
					theme={theme}
					onClose={vi.fn()}
					sshRemoteId="ssh-1"
				/>
			</LayerStackProvider>
		);
		expect(await screen.findAllByText('Add renderer integration')).toHaveLength(2);
		expect(await screen.findByText('No diff available for this commit')).toBeInTheDocument();
		expect(window.maestro.git.log).toHaveBeenLastCalledWith(
			'/workspace/failure',
			{ limit: 200 },
			'ssh-1'
		);
		expect(window.maestro.git.commitCount).toHaveBeenLastCalledWith('/workspace/failure', 'ssh-1');
	});
});
