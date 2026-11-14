import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	resolveModelEffort,
	useAgentModelEffortOptions,
} from '../../../renderer/hooks/agent/useAgentModelEffortOptions';

describe('useAgentModelEffortOptions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		window.maestro.agents.onModelsRefreshed = vi.fn(() => () => {});
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
		expect(result.current).toMatchObject({
			models: [],
			efforts: [],
			defaultModel: '',
			defaultEffort: '',
			loaded: false,
		});
	});

	it('refreshes the selected remote host and ignores lists broadcast for another host', async () => {
		const { result } = renderHook(() => useAgentModelEffortOptions('codex', 'remote'));
		await waitFor(() => expect(result.current.loaded).toBe(true));
		const listener = vi.mocked(window.maestro.agents.onModelsRefreshed).mock.calls.at(-1)![0];
		act(() => listener({ agentId: 'codex', sshRemoteId: null, models: ['local-only'] }));
		expect(result.current.models).toEqual(['gpt-model']);
		act(() => listener({ agentId: 'codex', sshRemoteId: 'remote', models: ['remote-fresh'] }));
		expect(result.current.models).toEqual(['remote-fresh']);
		vi.mocked(window.maestro.agents.getModels).mockResolvedValueOnce(['manual-refresh']);
		await act(async () => result.current.refreshModels());
		expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith('codex', true, 'remote');
		expect(result.current.models).toEqual(['manual-refresh']);
	});

	it('does not apply a manual refresh that finishes after a host switch', async () => {
		const { result, rerender } = renderHook(
			({ host }) => useAgentModelEffortOptions('codex', host),
			{ initialProps: { host: 'remote-a' } }
		);
		await waitFor(() => expect(result.current.loaded).toBe(true));
		let finish!: (models: string[]) => void;
		vi.mocked(window.maestro.agents.getModels)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					finish = resolve;
				})
			)
			.mockResolvedValueOnce(['remote-b-model']);
		let refreshing!: Promise<void>;
		act(() => {
			refreshing = result.current.refreshModels();
		});
		rerender({ host: 'remote-b' });
		await waitFor(() => expect(result.current.models).toEqual(['remote-b-model']));
		await act(async () => {
			finish(['stale-a-model']);
			await refreshing;
		});
		expect(result.current.models).toEqual(['remote-b-model']);
	});
});
