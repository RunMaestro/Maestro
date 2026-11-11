import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { AgentCreationDialog } from '../../../renderer/components/AgentCreationDialog';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import type { AgentDiscoveryRequest, AgentDiscoveryResult } from '../../../shared/types';
import type { RegisteredRepository, SymphonyIssue } from '../../../shared/symphony-types';
import { mockTheme } from '../../helpers/mockTheme';
import { resetStore } from '../../helpers/resetStores';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

// Isolate store-backed UI utilities; exercise the real config panel and discovery hooks.
vi.mock('../../../renderer/utils/openUrl', () => ({ openUrl: vi.fn() }));
vi.mock('../../../renderer/hooks/ui/useResizableModal', () => ({
	useResizableModal: () => ({ modalRef: { current: null }, style: {}, onResizeStart: vi.fn() }),
}));
const repo: RegisteredRepository = {
	slug: 'test-owner/test-repo',
	name: 'Test Repository',
	description: 'Synthetic repository',
	url: 'https://github.com/test-owner/test-repo',
	category: 'developer-tools',
	maintainer: { name: 'Test' },
	isActive: true,
	addedAt: '2026-10-30',
};
const issue: SymphonyIssue = {
	number: 1,
	title: 'Test Issue',
	body: '',
	url: 'https://example.test/issues/1',
	htmlUrl: 'https://example.test/issues/1',
	author: 'test',
	createdAt: '2026-10-30',
	updatedAt: '2026-10-30',
	labels: [],
	status: 'available',
	documentPaths: [{ name: 'task.md', path: 'docs/task.md', isExternal: false }],
};
const unavailable: AgentDiscoveryResult = { status: 'unavailable', options: [] };
const originalModels = window.maestro.agents.getModels;
const originalOptions = window.maestro.agents.getConfigOptions;
const onCreateAgent = vi.fn().mockResolvedValue({ success: true });
const props = { theme: mockTheme, isOpen: true, onClose: vi.fn(), repo, issue, onCreateAgent };
const dialog = (overrides: Partial<typeof props> = {}) => (
	<LayerStackProvider>
		<AgentCreationDialog {...props} {...overrides} />
	</LayerStackProvider>
);
const settle = async () => {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(300);
	});
};
const field = (label: string) =>
	within(screen.getByText(label).parentElement!).getByRole('textbox');
const change = (input: HTMLElement, value: string) =>
	fireEvent.change(input, { target: { value } });

beforeEach(() => {
	resetStore(useSettingsStore);
	vi.useFakeTimers();
	vi.clearAllMocks();
	vi.mocked(window.maestro.agents.detect).mockResolvedValue(
		['grok', 'codex'].map((id) => ({
			...getAgentDefinition(id)!,
			available: true,
			path: `/synthetic/bin/${id}`,
			capabilities: getAgentCapabilities(id),
		}))
	);
	vi.mocked(window.maestro.agents.getConfig).mockReset().mockResolvedValue({});
	vi.mocked(window.maestro.fs.homeDir).mockReset().mockResolvedValue('/synthetic/home');
	window.maestro.agents.getModels = vi
		.fn()
		.mockImplementation(async (request) =>
			typeof request === 'string' ? ['legacy-model'] : unavailable
		);
	window.maestro.agents.getConfigOptions = vi
		.fn()
		.mockImplementation(async (request) =>
			typeof request === 'string' ? ['low', 'high'] : unavailable
		);
});
afterEach(() => {
	cleanup();
	resetStore(useSettingsStore);
	window.maestro.agents.getModels = originalModels;
	window.maestro.agents.getConfigOptions = originalOptions;
	vi.mocked(window.maestro.agents.getConfig).mockReset().mockResolvedValue({});
	vi.mocked(window.maestro.fs.homeDir).mockReset().mockResolvedValue('/synthetic/home');
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('Symphony Grok draft discovery', () => {
	it.each(['Enter', ' '])('selects Grok with %s and submits only the chosen draft', async (key) => {
		const defaults = {
			model: 'provider-model',
			reasoningEffort: 'high',
			customEnvVars: { GROK_HOME: '/synthetic/default' },
		};
		const original = structuredClone({ defaults, repo, issue });
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValue(defaults);
		render(dialog());
		await act(async () => {});
		fireEvent.click(screen.getByText('Codex'));
		const grok = screen.getByRole('button', { name: /^Grok CLI/ });
		fireEvent.keyDown(grok, { key });
		expect(screen.getByRole('dialog', { name: 'Create Symphony Agent' })).toBeInTheDocument();
		change(screen.getByRole('textbox', { name: 'Session Name' }), '  Grok contribution  ');
		change(screen.getByRole('textbox', { name: 'Working Directory' }), '  /synthetic/work  ');
		change(screen.getByRole('textbox', { name: 'Path' }), '  /synthetic/custom grok  ');
		change(screen.getByRole('textbox', { name: 'Custom Arguments' }), '  --verbose  ');
		const explicit = key === ' ';
		if (explicit) {
			change(field('Model'), 'grok-4.5');
			change(field('Reasoning Effort'), 'low');
		}
		fireEvent.blur(screen.getByRole('textbox', { name: 'Path' }));
		await settle();
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
		});
		expect(onCreateAgent).toHaveBeenCalledExactlyOnceWith({
			agentType: 'grok',
			sessionName: 'Grok contribution',
			workingDirectory: '/synthetic/work',
			repo,
			issue,
			customPath: '/synthetic/custom grok',
			customArgs: '--verbose',
			customEnvVars: undefined,
			agentConfig: explicit ? { model: 'grok-4.5', reasoningEffort: 'low' } : undefined,
			enableMaestroP: undefined,
			maestroPMode: undefined,
			maestroPPath: undefined,
		});
		expect(onCreateAgent.mock.calls[0][0]).not.toHaveProperty('agentSessionId');
		expect(onCreateAgent.mock.calls[0][0]).not.toHaveProperty('nativeSessionBinding');
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expect(window.maestro.agents.setConfig).not.toHaveBeenCalled();
		expect({ defaults, repo, issue }).toEqual(original);
	});

	it('blocks creation until initial detection and working directory initialization finish', async () => {
		let resolveDetection!: (
			agents: Awaited<ReturnType<typeof window.maestro.agents.detect>>
		) => void;
		let resolveHome!: (home: string) => void;
		vi.mocked(window.maestro.agents.detect).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveDetection = resolve;
			})
		);
		vi.mocked(window.maestro.fs.homeDir).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveHome = resolve;
			})
		);
		render(dialog());
		const create = screen.getByRole('button', { name: 'Create Agent' });
		expect(create).toBeDisabled();
		fireEvent.click(create);
		await act(async () => {
			resolveDetection([
				{
					...getAgentDefinition('grok')!,
					available: true,
					path: '/synthetic/bin/grok',
					capabilities: getAgentCapabilities('grok'),
				},
			]);
		});
		expect(create).toBeDisabled();
		fireEvent.click(create);
		expect(onCreateAgent).not.toHaveBeenCalled();
		await act(async () => {
			resolveHome('/synthetic/home');
		});
		expect(create).not.toBeDisabled();
		await act(async () => {
			fireEvent.click(create);
		});
		expect(onCreateAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'grok',
				workingDirectory: '/synthetic/home/Maestro-Symphony/test-owner-test-repo-1',
			})
		);
	});

	it('blocks refresh and a missing binary without substituting another provider', async () => {
		const agent = {
			...getAgentDefinition('grok')!,
			available: true,
			path: '/synthetic/bin/grok',
			capabilities: getAgentCapabilities('grok'),
		};
		vi.mocked(window.maestro.agents.detect).mockResolvedValue([agent]);
		render(dialog());
		await act(async () => {});
		fireEvent.click(screen.getByText('Grok CLI'));
		change(screen.getByRole('textbox', { name: 'Path' }), '/synthetic/unverified-custom');
		let resolveDetection!: (agents: (typeof agent)[]) => void;
		vi.mocked(window.maestro.agents.detect).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveDetection = resolve;
			})
		);
		fireEvent.click(screen.getByRole('button', { name: 'Refresh detection' }));
		const create = screen.getByRole('button', { name: 'Create Agent' });
		expect(create).toBeDisabled();
		fireEvent.click(create);
		await act(async () => {
			resolveDetection([{ ...agent, available: false }]);
		});
		expect(screen.getByText('No compatible AI agents detected.')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Grok CLI/ })).not.toBeInTheDocument();
		expect(create).toBeDisabled();
		fireEvent.click(create);
		expect(onCreateAgent).not.toHaveBeenCalled();
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
	});

	it.each(['absent', 'removed', 'blank', 'account', 'account-b'])(
		'uses the same %s environment for discovery and creation',
		async (mode) => {
			render(dialog());
			await act(async () => {});
			fireEvent.click(screen.getByText('Grok CLI'));
			change(screen.getByPlaceholderText('/path/to/grok'), '/synthetic/custom grok');
			change(screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo'), '/synthetic/work');
			change(field('Model'), 'manual-model');
			change(field('Reasoning Effort'), 'manual-effort');
			if (mode !== 'absent') {
				fireEvent.click(screen.getByText('Add Variable'));
				const key = screen.getByRole('combobox');
				change(key, 'GROK_HOME');
				fireEvent.blur(key);
				if (mode.startsWith('account'))
					change(
						screen.getByPlaceholderText('value'),
						`/synthetic/${mode === 'account' ? 'account-a' : mode}`
					);
				if (mode === 'removed') fireEvent.click(screen.getByTitle('Remove variable'));
			}
			const customEnvVars =
				mode === 'blank'
					? { GROK_HOME: '' }
					: mode.startsWith('account')
						? { GROK_HOME: `/synthetic/${mode === 'account' ? 'account-a' : mode}` }
						: mode === 'removed'
							? {}
							: undefined;
			const context: AgentDiscoveryRequest['context'] = {
				kind: 'draft',
				cwd: '/synthetic/work',
				customPath: '/synthetic/custom grok',
				customEnvVars,
				model: 'manual-model',
				effort: 'manual-effort',
			};
			await settle();
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith({
				providerId: 'grok',
				context,
			});
			expect(window.maestro.agents.getConfigOptions).toHaveBeenCalledWith(
				{ providerId: 'grok', context },
				'reasoningEffort'
			);
			expect(screen.getByTestId('config-option-note-model')).toHaveTextContent('unavailable');
			await act(async () => {
				fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
			});
			expect(onCreateAgent).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'grok',
					workingDirectory: context.cwd,
					customPath: context.customPath,
					customEnvVars,
					agentConfig: { model: 'manual-model', reasoningEffort: 'manual-effort' },
				})
			);
		}
	);

	it.each(['unavailable', 'configured-fallback'] as const)(
		'retains manual values after %s refresh',
		async (status) => {
			render(dialog());
			await act(async () => {});
			fireEvent.click(screen.getByText('Grok CLI'));
			change(field('Model'), 'manual-model');
			change(field('Reasoning Effort'), 'manual-effort');
			await settle();
			vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
				status,
				options: status === 'unavailable' ? [] : ['configured-model'],
			});
			vi.mocked(window.maestro.agents.getConfigOptions).mockResolvedValue({
				status,
				options: ['configured-effort'],
			});
			fireEvent.click(screen.getByTitle('Refresh available models'));
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
				expect.objectContaining({
					providerId: 'grok',
					forceRefresh: true,
					context: expect.objectContaining({ model: 'manual-model', effort: 'manual-effort' }),
				})
			);
			await act(async () => {});
			await settle();
			expect(field('Model')).toHaveValue('manual-model');
			expect(field('Reasoning Effort')).toHaveValue('manual-effort');
			expect(screen.getByTestId('config-option-note-model')).toHaveTextContent('unavailable');
			expect(screen.getByTestId('config-option-note-reasoningEffort')).toHaveTextContent(
				'unavailable'
			);
		}
	);

	it.each(['account', 'path', 'cwd', 'provider', 'close', 'refresh'])(
		'ignores late catalogs after a %s change',
		async (transition) => {
			const view = render(dialog());
			await act(async () => {});
			fireEvent.click(screen.getByText('Grok CLI'));
			change(field('Model'), 'manual');
			change(field('Reasoning Effort'), 'manual-effort');
			await settle();
			let resolveOld!: (value: AgentDiscoveryResult) => void;
			const old = new Promise<AgentDiscoveryResult>((resolve) => {
				resolveOld = resolve;
			});
			vi.mocked(window.maestro.agents.getModels).mockReturnValueOnce(old);
			if (transition === 'refresh') fireEvent.click(screen.getByTitle('Refresh available models'));
			else {
				vi.mocked(window.maestro.agents.getConfigOptions)
					.mockReturnValueOnce(old)
					.mockReturnValueOnce(old);
				change(screen.getByPlaceholderText('/path/to/grok'), '/synthetic/pending');
				await settle();
			}
			if (transition === 'provider') fireEvent.click(screen.getByText('Codex'));
			else if (transition === 'close') view.rerender(dialog({ isOpen: false }));
			else if (transition === 'account') {
				fireEvent.click(screen.getByText('Add Variable'));
				const key = screen.getByRole('combobox');
				change(key, 'GROK_HOME');
				fireEvent.blur(key);
				change(screen.getByPlaceholderText('value'), '/synthetic/account-b');
			} else if (transition === 'cwd')
				change(screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo'), '/synthetic/next');
			else change(screen.getByPlaceholderText('/path/to/grok'), '/synthetic/current');
			await settle();
			const calls = vi.mocked(window.maestro.agents.getModels).mock.calls.length;
			await act(async () => {
				resolveOld({ status: 'discovered', options: ['manual-old-account'] });
			});
			await settle();
			expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(calls);
			if (transition === 'close') {
				expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
				view.rerender(dialog());
				await act(async () => {});
				await settle();
			} else if (transition === 'provider') {
				expect(window.maestro.agents.getModels).toHaveBeenCalledWith('codex', false);
				fireEvent.click(screen.getByText('Grok CLI'));
				await settle();
			}
			fireEvent.focus(field('Model'));
			expect(screen.queryByRole('button', { name: 'manual-old-account' })).not.toBeInTheDocument();
			expect(field('Model')).toHaveValue('manual');
			expect(field('Reasoning Effort')).toHaveValue('manual-effort');
			expect(screen.getByTestId('config-option-note-reasoningEffort')).toHaveTextContent(
				'unavailable'
			);
		}
	);

	it('hides a populated menu immediately when cwd changes, before debounced discovery', async () => {
		render(dialog());
		await act(async () => {});
		fireEvent.click(screen.getByText('Grok CLI'));
		vi.mocked(window.maestro.agents.getModels).mockResolvedValue({
			status: 'discovered',
			options: ['old-account-model'],
		});
		await settle();
		fireEvent.focus(field('Model'));
		expect(screen.getByRole('button', { name: 'old-account-model' })).toBeInTheDocument();
		const calls = vi.mocked(window.maestro.agents.getModels).mock.calls.length;
		change(
			screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo'),
			'/synthetic/new-workspace'
		);
		expect(screen.queryByRole('button', { name: 'old-account-model' })).not.toBeInTheDocument();
		expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(calls);
		await settle();
		expect(window.maestro.agents.getModels).toHaveBeenCalledTimes(calls + 1);
	});

	// The manual-edit race: a late home directory never overwrites a changed draft.
	it.each(['repo', 'close', 'manual'])(
		'does not apply a late home directory to a changed %s draft',
		async (transition) => {
			let resolveHome!: (value: string) => void;
			vi.mocked(window.maestro.fs.homeDir).mockReturnValueOnce(
				new Promise((resolve) => {
					resolveHome = resolve;
				})
			);
			const view = render(dialog());
			await act(async () => {});
			if (transition === 'close') {
				view.rerender(dialog({ isOpen: false }));
				view.rerender(dialog());
			} else if (transition === 'repo')
				view.rerender(dialog({ repo: { ...repo, slug: 'new-owner/new-repo' } }));
			await act(async () => {});
			const cwd = screen.getByPlaceholderText('~/Maestro-Symphony/owner-repo');
			change(cwd, '/synthetic/manual-work');
			await act(async () => {
				resolveHome('/synthetic/obsolete-home');
			});
			expect(cwd).toHaveValue('/synthetic/manual-work');
			fireEvent.click(screen.getByText('Grok CLI'));
			await settle();
			expect(window.maestro.agents.getModels).toHaveBeenLastCalledWith(
				expect.objectContaining({
					context: expect.objectContaining({ cwd: '/synthetic/manual-work' }),
				})
			);
		}
	);
});
