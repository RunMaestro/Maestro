import type { ModelsRefreshedPayload } from '../../../shared/agentModelsRefresh';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { createElement, startTransition, Suspense } from 'react';
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
			refreshModels: expect.any(Function),
			refreshingModels: false,
		});
	});
});

describe('scoped model refresh ordering', () => {
	it('keeps the committed scope active while a new scope is suspended', async () => {
		let broadcast!: (payload: ModelsRefreshedPayload) => void;
		Object.assign(window.maestro.agents, {
			onModelsRefreshed: vi.fn((listener) => {
				broadcast = listener;
				return vi.fn();
			}),
		});
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['initial']);
		const suspended = new Promise<never>(() => {});
		function Picker({ host }: { host: string }) {
			const options = useAgentModelEffortOptions('codex', host);
			if (host === 'b') throw suspended;
			return createElement('div', null, options.models.join(','));
		}
		const view = (host: string) =>
			createElement(Suspense, { fallback: 'loading' }, createElement(Picker, { host }));
		const { rerender, getByText } = render(view('a'));
		await waitFor(() => expect(getByText('initial')).toBeTruthy());
		act(() => {
			startTransition(() => rerender(view('b')));
		});
		act(() => {
			broadcast({ agentId: 'codex', sshRemoteId: 'a', models: ['committed'] });
		});
		expect(getByText('committed')).toBeTruthy();
	});
	it('uses the selected host for a forced refresh and ignores an older initial discovery', async () => {
		let initial!: (models: string[]) => void;
		vi.mocked(window.maestro.agents.getModels)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					initial = resolve;
				})
			)
			.mockResolvedValueOnce(['fresh']);
		const { result } = renderHook(() => useAgentModelEffortOptions('codex', 'remote'));
		await act(async () => {
			await result.current.refreshModels();
		});
		expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith('codex', true, 'remote');
		expect(result.current.models).toEqual(['fresh']);
		await act(async () => {
			initial(['old']);
		});
		expect(result.current.loaded).toBe(true);
		expect(result.current.models).toEqual(['fresh']);
	});
	it('adopts only matching broadcasts and keeps them ahead of initial results', async () => {
		let broadcast!: (payload: ModelsRefreshedPayload) => void;
		let initial!: (models: string[]) => void;
		const unsubscribe = vi.fn();
		Object.assign(window.maestro.agents, {
			onModelsRefreshed: vi.fn((listener) => {
				broadcast = listener;
				return unsubscribe;
			}),
		});
		vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
			new Promise((resolve) => {
				initial = resolve;
			})
		);
		const { result, unmount } = renderHook(() => useAgentModelEffortOptions('codex', 'remote'));
		act(() => {
			broadcast({ agentId: 'codex', sshRemoteId: null, models: ['local'] });
		});
		expect(result.current.models).toEqual([]);
		act(() => {
			broadcast({ agentId: 'opencode', sshRemoteId: 'remote', models: ['foreign'] });
		});
		expect(result.current.models).toEqual([]);
		act(() => {
			broadcast({ agentId: 'codex', sshRemoteId: 'remote', models: ['newest'] });
		});
		await act(async () => {
			initial(['old']);
		});
		expect(result.current.models).toEqual(['newest']);
		unmount();
		expect(unsubscribe).toHaveBeenCalledOnce();
	});
	it('does not let an old host refresh overwrite a new host or its spinner', async () => {
		let old!: (models: string[]) => void;
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue(['first']);
		const { result, rerender } = renderHook(
			({ host }) => useAgentModelEffortOptions('codex', host),
			{ initialProps: { host: 'a' } }
		);
		await waitFor(() => expect(result.current.loaded).toBe(true));
		vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(
			new Promise((resolve) => {
				old = resolve;
			})
		);
		let pending!: Promise<void>;
		act(() => {
			pending = result.current.refreshModels();
		});
		rerender({ host: 'b' });
		expect(result.current.models).toEqual([]);
		expect(result.current.refreshingModels).toBe(false);
		await waitFor(() => expect(result.current.loaded).toBe(true));
		await act(async () => {
			old(['wrong-host']);
			await pending;
		});
		expect(result.current.models).toEqual(['first']);
	});
});

describe('initial discovery during a forced refresh', () => {
	it.each(['failure', 'pending'])(
		'keeps successful initial models when a newer refresh is %s',
		async (outcome) => {
			let initial!: (models: string[]) => void;
			let failRefresh!: (error: Error) => void;
			vi.mocked(window.maestro.agents.getModels)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						initial = resolve;
					})
				)
				.mockReturnValueOnce(
					new Promise((_resolve, reject) => {
						failRefresh = reject;
					})
				);
			const { result, unmount } = renderHook(() => useAgentModelEffortOptions('codex', 'remote'));
			let pending!: Promise<void>;
			act(() => {
				pending = result.current.refreshModels();
			});
			expect(result.current.refreshingModels).toBe(true);
			await act(async () => {
				initial(['initial-success']);
			});
			expect(result.current.loaded).toBe(true);
			if (outcome === 'failure') {
				await act(async () => {
					failRefresh(new Error('refresh failed'));
					await pending;
				});
				expect(result.current.refreshingModels).toBe(false);
			} else {
				expect(result.current.refreshingModels).toBe(true);
			}
			expect(result.current.models).toEqual(['initial-success']);
			unmount();
		}
	);
	it.each(['before initial', 'after initial'])(
		'keeps a newer matching broadcast %s ahead of both responses',
		async (ordering) => {
			let initial!: (models: string[]) => void;
			let finishRefresh!: (models: string[]) => void;
			let broadcast!: (payload: ModelsRefreshedPayload) => void;
			Object.assign(window.maestro.agents, {
				onModelsRefreshed: vi.fn((listener) => {
					broadcast = listener;
					return vi.fn();
				}),
			});
			vi.mocked(window.maestro.agents.getModels)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						initial = resolve;
					})
				)
				.mockReturnValueOnce(
					new Promise((resolve) => {
						finishRefresh = resolve;
					})
				);
			const { result } = renderHook(() => useAgentModelEffortOptions('codex', 'remote'));
			let pending!: Promise<void>;
			act(() => {
				pending = result.current.refreshModels();
			});
			if (ordering === 'after initial')
				await act(async () => {
					initial(['initial-success']);
				});
			act(() => {
				broadcast({ agentId: 'codex', sshRemoteId: 'remote', models: ['broadcast-newest'] });
			});
			await act(async () => {
				if (ordering === 'before initial') initial(['initial-success']);
				finishRefresh(['refresh-response']);
				await pending;
			});
			expect(result.current.loaded).toBe(true);
			expect(result.current.models).toEqual(['broadcast-newest']);
			expect(result.current.refreshingModels).toBe(false);
		}
	);
});
