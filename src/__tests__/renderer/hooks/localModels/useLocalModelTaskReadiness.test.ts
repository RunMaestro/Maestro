import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useLocalModelTaskReadiness } from '../../../../renderer/hooks/localModels/useLocalModelTaskReadiness';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import type { LocalModelTaskReadiness } from '../../../../shared/local-models/task-readiness';

afterEach(cleanup);

describe('desktop local model task readiness', () => {
	it('still asks on mount, revision and manual refresh and renders the host answer', async () => {
		expect(isWebDesktop()).toBe(false);
		const answer: LocalModelTaskReadiness = {
			taskId: 'git-drafts',
			label: 'Git drafts',
			needs: 'text-gen',
			assignment: { type: 'off' },
			state: 'off',
			detail: 'This task is switched off.',
		};
		const readiness = vi.mocked(window.maestro.localModels.taskReadiness);
		readiness.mockReset().mockResolvedValue([answer]);
		const { result, rerender } = renderHook(
			({ revision }) => useLocalModelTaskReadiness(revision, 'git-drafts'),
			{ initialProps: { revision: 'first' } }
		);
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(readiness).toHaveBeenCalledExactlyOnceWith('git-drafts');
		expect(result.current.readiness).toEqual({ 'git-drafts': answer });
		rerender({ revision: 'changed-settings' });
		await waitFor(() => expect(readiness).toHaveBeenCalledTimes(2));
		await act(async () => {
			await result.current.refresh();
		});
		expect(readiness).toHaveBeenCalledTimes(3);
		expect(result.current).toMatchObject({
			readiness: { 'git-drafts': answer },
			loading: false,
			error: null,
		});
	});
});
