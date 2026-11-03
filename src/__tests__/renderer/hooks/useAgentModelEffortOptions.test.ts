import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	resolveModelEffort,
	useAgentModelEffortOptions,
} from '../../../renderer/hooks/agent/useAgentModelEffortOptions';

describe('useAgentModelEffortOptions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['gpt-model']);
		vi.mocked(window.maestro.agents.getConfigOptions).mockImplementation(async (id, key) =>
			id === 'codex' && key === 'reasoningEffort' ? ['low', 'high'] : []
		);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue({
			model: 'gpt-model',
			reasoningEffort: 'high',
		});
	});

	it('discovers models on the selected host and uses provider defaults', async () => {
		const { result } = renderHook(() => useAgentModelEffortOptions('codex', 'remote'));
		await waitFor(() => expect(result.current.loaded).toBe(true));
		expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false, 'remote');
		expect(result.current.efforts).toEqual(['low', 'high']);
		expect(resolveModelEffort(undefined, undefined, result.current)).toEqual({
			model: 'gpt-model',
			effort: 'high',
		});
	});

	it.each(['provider', 'host'])(
		'hides previous options and discards late replies on a %s switch',
		async (axis) => {
			let finish!: (models: string[]) => void;
			vi.mocked(window.maestro.agents.getModels)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						finish = resolve;
					})
				)
				.mockResolvedValueOnce(['destination-model']);
			const { result, rerender } = renderHook(
				({ provider, host }) => useAgentModelEffortOptions(provider, host),
				{ initialProps: { provider: 'codex', host: 'host-a' } }
			);
			rerender({ provider: axis === 'provider' ? 'opencode' : 'codex', host: 'host-b' });
			expect(result.current.models).toEqual([]);
			expect(result.current.loaded).toBe(false);
			await waitFor(() => expect(result.current.models).toEqual(['destination-model']));
			await act(async () => {
				finish(['stale-model']);
			});
			expect(result.current.models).toEqual(['destination-model']);
			if (axis === 'provider') expect(result.current.efforts).toEqual([]);
		}
	);

	it('clears a loaded scope when no provider is selected', async () => {
		const { result, rerender } = renderHook(
			({ provider }: { provider?: string }) => useAgentModelEffortOptions(provider),
			{ initialProps: { provider: 'codex' } }
		);
		await waitFor(() => expect(result.current.loaded).toBe(true));
		rerender({ provider: undefined });
		expect(result.current).toEqual({
			models: [],
			efforts: [],
			defaultModel: '',
			defaultEffort: '',
			loaded: false,
		});
	});
});
