import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	usePlaybookManagement,
	type UsePlaybookManagementDeps,
} from '../../../../renderer/hooks/batch/usePlaybookManagement';

function deps(overrides: Partial<UsePlaybookManagementDeps> = {}): UsePlaybookManagementDeps {
	return {
		sessionId: 'session-1',
		folderPath: '/autorun',
		allDocuments: [],
		config: {
			documents: [],
			loopEnabled: false,
			maxLoops: null,
			prompt: '',
			taskSelectionMode: 'task',
		},
		onApplyPlaybook: vi.fn(),
		...overrides,
	};
}

describe('usePlaybookManagement playbook list', () => {
	let changedHandler: ((sessionId: string) => void) | null;
	const unsubscribe = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		changedHandler = null;
		vi.mocked(window.maestro.playbooks.onChanged).mockImplementation((handler) => {
			changedHandler = handler;
			return unsubscribe;
		});
	});

	it('reloads the list when main reports a write to this agent, without remounting', async () => {
		vi.mocked(window.maestro.playbooks.list)
			.mockResolvedValueOnce({ success: true, playbooks: [] })
			.mockResolvedValueOnce({
				success: true,
				playbooks: [{ id: 'pb-new', name: 'Installed' } as never],
			});

		const { result } = renderHook(() => usePlaybookManagement(deps()));
		await waitFor(() => expect(result.current.loadingPlaybooks).toBe(false));
		expect(result.current.playbooks).toEqual([]);

		act(() => changedHandler?.('session-1'));

		await waitFor(() => expect(result.current.playbooks).toHaveLength(1));
		expect(result.current.playbooks[0].id).toBe('pb-new');
		expect(result.current.loadingPlaybooks).toBe(false);
		expect(window.maestro.playbooks.list).toHaveBeenCalledTimes(2);
	});

	it("ignores another agent's writes and unsubscribes on unmount", async () => {
		vi.mocked(window.maestro.playbooks.list).mockResolvedValue({ success: true, playbooks: [] });

		const { result, unmount } = renderHook(() => usePlaybookManagement(deps()));
		await waitFor(() => expect(result.current.loadingPlaybooks).toBe(false));

		act(() => changedHandler?.('session-2'));
		expect(window.maestro.playbooks.list).toHaveBeenCalledTimes(1);

		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});
