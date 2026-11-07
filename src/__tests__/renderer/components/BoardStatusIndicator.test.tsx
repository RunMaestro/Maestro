import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { BoardStatusIndicator } from '../../../renderer/components/BoardStatusIndicator';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: (selector: (state: unknown) => unknown) =>
		selector({ encoreFeatures: { board: true, maestroCue: true } }),
}));

describe('BoardStatusIndicator', () => {
	it('refreshes on global and matching project changes, but not unrelated projects', async () => {
		let changed: ((event: { projectRoot: string }) => void) | undefined;
		const list = vi.fn().mockResolvedValue([]);
		const originalBoard = window.maestro.board;
		window.maestro.board = {
			list,
			onBoardChanged: (callback: (event: { projectRoot: string }) => void) => {
				changed = callback;
				return () => {};
			},
		} as typeof window.maestro.board;
		try {
			const view = render(<BoardStatusIndicator projectRoot="/project" theme={mockTheme} />);
			await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
			list.mockResolvedValue([{ cards: [{ status: 'running' }] }]);
			act(() => changed?.({ projectRoot: '/other' }));
			expect(list).toHaveBeenCalledTimes(1);
			act(() => changed?.({ projectRoot: '' }));
			await screen.findByLabelText('Board: 1 running, 0 ready');
			expect(list).toHaveBeenCalledWith('/project');
			list.mockResolvedValue([{ cards: [{ status: 'ready' }] }]);
			act(() => changed?.({ projectRoot: '/project' }));
			await screen.findByLabelText('Board: 0 running, 1 ready');
			expect(list).toHaveBeenCalledTimes(3);
			view.unmount();
		} finally {
			window.maestro.board = originalBoard;
		}
	});
});
