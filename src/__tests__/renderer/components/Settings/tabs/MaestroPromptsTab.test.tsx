/**
 * Tests for MaestroPromptsTab — selection precedence and persistence.
 *
 * Covers the default-on-open behavior:
 *   1) explicit initialSelectedPromptId prop wins
 *   2) remembered lastSelectedPromptId from settings next
 *   3) then the well-known maestro-system-prompt
 *   4) finally the first prompt in the list
 *
 * Also verifies that picking a prompt persists lastSelectedPromptId and that
 * the shared list renders each item with a data-item-id for scroll-into-view.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';

const mockSetLastSelectedPromptId = vi.fn();
let mockLastSelectedPromptId: string | null = null;
let mockActiveSession: any = null;
let mockTemplateAutocompleteResult: any = null;

vi.mock('../../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: vi.fn((selector: (s: unknown) => unknown) =>
		selector({
			conductorProfile: '',
			lastSelectedPromptId: mockLastSelectedPromptId,
			setLastSelectedPromptId: mockSetLastSelectedPromptId,
		})
	),
}));

vi.mock('../../../../../renderer/hooks/session/useActiveSession', () => ({
	useActiveSession: () => mockActiveSession,
}));

vi.mock('../../../../../renderer/services/promptInit', () => ({
	refreshRendererPrompts: vi.fn(async () => {}),
}));

vi.mock('../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(async () => {}),
	captureMessage: vi.fn(async () => {}),
}));

vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: vi.fn(),
}));

vi.mock('../../../../../renderer/utils/buildMaestroUrl', () => ({
	buildMaestroUrl: (u: string) => u,
}));

vi.mock('../../../../../renderer/services/git', () => ({
	gitService: { getStatus: vi.fn(async () => ({ branch: 'main' })) },
}));

vi.mock('../../../../../renderer/hooks/input/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: vi.fn(
		({ onChange }: { onChange: (value: string) => void }) =>
			mockTemplateAutocompleteResult ?? {
				handleKeyDown: vi.fn(),
				autocompleteRef: { current: null },
				autocompleteState: { isOpen: false },
				selectVariable: vi.fn(),
				handleChange: (e: { target: { value: string } }) => onChange(e.target.value),
			}
	),
}));

vi.mock('../../../../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: () => null,
}));

import { MaestroPromptsTab } from '../../../../../renderer/components/Settings/tabs/MaestroPromptsTab';

const mockTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#000',
		bgSidebar: '#000',
		bgActivity: '#000',
		border: '#000',
		textMain: '#fff',
		textDim: '#aaa',
		accent: '#f0f',
		accentDim: '#f0f20',
		accentText: '#f0f',
		accentForeground: '#fff',
		success: '#0f0',
		warning: '#ff0',
		error: '#f00',
	},
};

const PROMPTS = [
	{
		id: 'autorun-default',
		filename: 'autorun-default.md',
		description: 'Auto Run default prompt.',
		category: 'autorun',
		content: '# auto',
		isModified: false,
	},
	{
		id: 'maestro-system-prompt',
		filename: 'maestro-system-prompt.md',
		description: 'Maestro system context.',
		category: 'system',
		content: '# system',
		isModified: true,
		hasDefaultDrifted: true,
	},
	{
		id: 'wizard-system',
		filename: 'wizard-system.md',
		description: 'Wizard system prompt.',
		category: 'wizard',
		content: '# wizard',
		isModified: false,
	},
];

function setupWindowMaestro() {
	(window as any).maestro = {
		prompts: {
			getAll: vi.fn(async () => ({ success: true, prompts: PROMPTS })),
			getPath: vi.fn(async () => ({ success: true, path: '/tmp/prompts' })),
			save: vi.fn(async () => ({ success: true })),
			reset: vi.fn(async () => ({ success: true, content: '' })),
			getBundledDefault: vi.fn(async () => ({ success: true, content: '# bundled default' })),
		},
		history: {
			getFilePath: vi.fn(async () => null),
		},
		settings: {
			set: vi.fn(),
		},
		shell: {
			openPath: vi.fn(),
		},
		platform: 'darwin',
	};
}

describe('MaestroPromptsTab selection precedence', () => {
	beforeEach(() => {
		mockSetLastSelectedPromptId.mockReset();
		mockLastSelectedPromptId = null;
		mockActiveSession = null;
		mockTemplateAutocompleteResult = null;
		vi.useRealTimers();
		setupWindowMaestro();
		vi.spyOn(window, 'confirm').mockReturnValue(true);
	});

	it('defaults to maestro-system-prompt when nothing else is specified', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => {
			expect(screen.getByRole('heading', { name: /^maestro-system-prompt/ })).toBeInTheDocument();
		});
	});

	it('restores the remembered lastSelectedPromptId on open', async () => {
		mockLastSelectedPromptId = 'wizard-system';
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => {
			expect(screen.getByRole('heading', { name: /^wizard-system/ })).toBeInTheDocument();
		});
	});

	it('prefers an explicit initialSelectedPromptId over the remembered one', async () => {
		mockLastSelectedPromptId = 'wizard-system';
		render(<MaestroPromptsTab theme={mockTheme} initialSelectedPromptId="autorun-default" />);
		await waitFor(() => {
			expect(screen.getByRole('heading', { name: /^autorun-default/ })).toBeInTheDocument();
		});
	});

	it('falls back to the first prompt if neither recall nor the default system prompt exist', async () => {
		mockLastSelectedPromptId = 'does-not-exist';
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: true,
			prompts: [
				{
					id: 'autorun-default',
					filename: 'autorun-default.md',
					description: 'a',
					category: 'autorun',
					content: '',
					isModified: false,
				},
				{
					id: 'wizard-system',
					filename: 'wizard-system.md',
					description: 'b',
					category: 'wizard',
					content: '',
					isModified: false,
				},
			],
		}));
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => {
			// Items are rendered sorted alphabetically by id, so autorun-default is first.
			expect(screen.getByRole('heading', { name: /^autorun-default/ })).toBeInTheDocument();
		});
	});

	it('persists lastSelectedPromptId on selection change', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));
		const wizardItem = await screen.findByRole('button', { name: /wizard-system/ });
		fireEvent.click(wizardItem);
		expect(mockSetLastSelectedPromptId).toHaveBeenCalledWith('wizard-system');
	});

	it('emits data-item-id on each list item so the shared list is scrollable into view', async () => {
		const { container } = render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));
		const ids = Array.from(
			container.querySelectorAll<HTMLElement>('.dual-pane-list-item[data-item-id]')
		).map((el) => el.dataset.itemId);
		expect(ids).toEqual(expect.arrayContaining(PROMPTS.map((p) => p.id)));
	});

	it('renders a live token count next to the editor title', async () => {
		const { container } = render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));
		const badge = container.querySelector<HTMLElement>(
			'.dual-pane-editor-header h3 .dual-pane-editor-token-count'
		);
		expect(badge).not.toBeNull();
		expect(badge!.textContent).toMatch(/^~\d.*tokens$/);
	});

	it('opens help, follows docs link, and closes help', async () => {
		const { openUrl } = await import('../../../../../renderer/utils/openUrl');
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Prompt reference'));
		expect(screen.getByText('What Are Core Prompts?')).toBeInTheDocument();

		fireEvent.click(screen.getByText(/Read more at docs.runmaestro.ai/));
		expect(openUrl).toHaveBeenCalledWith('https://docs.runmaestro.ai/prompt-customization');

		fireEvent.click(screen.getByTitle('Close help'));
		expect(screen.queryByText('What Are Core Prompts?')).not.toBeInTheDocument();
	});

	it('previews with no active session and exits preview mode', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(
			await screen.findByDisplayValue(/Preview unavailable: no active agent session/)
		).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Exit preview (show editable source)'));
		expect(screen.getByDisplayValue('# system')).toBeInTheDocument();
	});

	it('previews with active session data and tolerates git/history lookup failures', async () => {
		mockActiveSession = {
			id: 'session-1',
			cwd: '/repo',
			isGitRepo: true,
			groupId: 'group-1',
		};
		(window as any).maestro.history.getFilePath = vi.fn(async () => {
			throw new Error('history failed');
		});
		const { gitService } = await import('../../../../../renderer/services/git');
		vi.mocked(gitService.getStatus).mockRejectedValueOnce(new Error('git failed'));
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: true,
			prompts: [
				{
					id: 'maestro-system-prompt',
					filename: 'maestro-system-prompt.md',
					description: 'Maestro system context.',
					category: 'system',
					content: 'Cwd {{CWD}}',
					isModified: false,
				},
			],
		}));

		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(await screen.findByDisplayValue('Cwd /repo')).toBeInTheDocument();
	});

	it('previews active session git and history values', async () => {
		mockActiveSession = {
			id: 'session-1',
			cwd: '/repo',
			isGitRepo: true,
		};
		(window as any).maestro.history.getFilePath = vi.fn(async () => '/history/session-1.jsonl');
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: true,
			prompts: [
				{
					id: 'maestro-system-prompt',
					filename: 'maestro-system-prompt.md',
					description: 'Maestro system context.',
					category: 'system',
					content: 'Branch {{GIT_BRANCH}} History {{AGENT_HISTORY_PATH}}',
					isModified: false,
				},
			],
		}));

		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(
			await screen.findByDisplayValue('Branch main History /history/session-1.jsonl')
		).toBeInTheDocument();
	});

	it('previews active sessions without git or history values', async () => {
		mockActiveSession = {
			id: 'session-1',
			cwd: '/repo',
			isGitRepo: false,
		};
		(window as any).maestro.history.getFilePath = vi.fn(async () => null);
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: true,
			prompts: [
				{
					id: 'maestro-system-prompt',
					filename: 'maestro-system-prompt.md',
					description: 'Maestro system context.',
					category: 'system',
					content: 'Repo {{IS_GIT_REPO}} History "{{AGENT_HISTORY_PATH}}"',
					isModified: false,
				},
			],
		}));

		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(await screen.findByDisplayValue('Repo false History ""')).toBeInTheDocument();
	});

	it('reports preview interpolation failures', async () => {
		const { captureException } = await import('../../../../../renderer/utils/sentry');
		vi.mocked(captureException).mockClear();
		mockActiveSession = {
			id: 'session-1',
			cwd: '/repo',
			isGitRepo: false,
		};
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: true,
			prompts: [
				{
					id: 'maestro-system-prompt',
					filename: 'maestro-system-prompt.md',
					description: 'Maestro system context.',
					category: 'system',
					content: {
						replace: () => {
							throw new Error('preview exploded');
						},
					} as any,
					isModified: false,
				},
			],
		}));

		const { unmount } = render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(
			await screen.findByDisplayValue('Preview failed: Error: preview exploded')
		).toBeInTheDocument();
		expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
			extra: { context: 'MaestroPromptsTab.togglePreview' },
		});

		unmount();
		setupWindowMaestro();
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: true,
			prompts: [
				{
					id: 'maestro-system-prompt',
					filename: 'maestro-system-prompt.md',
					description: 'Maestro system context.',
					category: 'system',
					content: {
						replace: () => {
							throw 'preview string';
						},
					} as any,
					isModified: false,
				},
			],
		}));
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));
		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(await screen.findByDisplayValue('Preview failed: preview string')).toBeInTheDocument();
	});

	it('routes escape through help, preview, default, and expanded editor states', async () => {
		const onEscapeHandled = vi.fn();
		const latestEscapeHandler = () => {
			const call = [...onEscapeHandled.mock.calls]
				.reverse()
				.find(([handler]) => typeof handler === 'function');
			return call?.[0] as (() => boolean) | undefined;
		};
		render(<MaestroPromptsTab theme={mockTheme} onEscapeHandled={onEscapeHandled} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByTitle('Expand editor'));
		await waitFor(() => expect(screen.getByTitle('Collapse editor')).toBeInTheDocument());
		act(() => {
			expect(latestEscapeHandler()?.()).toBe(true);
		});
		await waitFor(() => expect(screen.getByTitle('Expand editor')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Expand editor'));
		await waitFor(() => expect(screen.getByTitle('Prompt reference')).toBeInTheDocument());
		fireEvent.click(screen.getByTitle('Prompt reference'));
		expect(screen.getByText('What Are Core Prompts?')).toBeInTheDocument();
		act(() => {
			expect(latestEscapeHandler()?.()).toBe(true);
		});
		await waitFor(() => {
			expect(screen.queryByText('What Are Core Prompts?')).not.toBeInTheDocument();
		});

		fireEvent.click(
			screen.getByTitle('View the current bundled default that shipped with this update')
		);
		expect(await screen.findByDisplayValue('# bundled default')).toBeInTheDocument();
		act(() => {
			expect(latestEscapeHandler()?.()).toBe(true);
		});
		await waitFor(() => expect(screen.getByDisplayValue('# system')).toBeInTheDocument());

		fireEvent.click(screen.getByTitle('Preview with template variables resolved'));
		expect(
			await screen.findByDisplayValue(/Preview unavailable: no active agent session/)
		).toBeInTheDocument();
		act(() => {
			expect(latestEscapeHandler()?.()).toBe(true);
		});
		await waitFor(() => expect(screen.getByDisplayValue('# system')).toBeInTheDocument());
	});

	it('passes editor keydown events through the template autocomplete hook', async () => {
		const handleKeyDown = vi.fn();
		mockTemplateAutocompleteResult = {
			handleKeyDown,
			autocompleteRef: { current: null },
			autocompleteState: { isOpen: false },
			selectVariable: vi.fn(),
			handleChange: vi.fn(),
		};
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.keyDown(screen.getByDisplayValue('# system'), { key: 'Tab' });
		expect(handleKeyDown).toHaveBeenCalled();
	});

	it('saves edited prompt content and clears the success message timer', async () => {
		const { refreshRendererPrompts } = await import('../../../../../renderer/services/promptInit');
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.change(screen.getByDisplayValue('# system'), { target: { value: '# updated' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect((window as any).maestro.prompts.save).toHaveBeenCalledWith(
				'maestro-system-prompt',
				'# updated'
			);
		});
		expect(refreshRendererPrompts).toHaveBeenCalled();
		expect(screen.getByText('Changes saved')).toBeInTheDocument();

		await waitFor(
			() => {
				expect(screen.queryByText('Changes saved')).not.toBeInTheDocument();
			},
			{ timeout: 3500 }
		);
	});

	it('handles save failure and thrown save errors', async () => {
		(window as any).maestro.prompts.save = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: 'save failed' })
			.mockRejectedValueOnce(new Error('save exploded'));
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.change(screen.getByDisplayValue('# system'), { target: { value: '# fail' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('save failed')).toBeInTheDocument();

		fireEvent.change(screen.getByDisplayValue('# fail'), { target: { value: '# throw' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Error: save exploded')).toBeInTheDocument();
	});

	it('uses fallback save errors for empty error responses and string throws', async () => {
		(window as any).maestro.prompts.save = vi
			.fn()
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce('save string');
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.change(screen.getByDisplayValue('# system'), { target: { value: '# fail' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('Failed to save prompt')).toBeInTheDocument();

		fireEvent.change(screen.getByDisplayValue('# fail'), { target: { value: '# throw' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(await screen.findByText('save string')).toBeInTheDocument();
	});

	it('resets modified prompts and handles reset decline or failure', async () => {
		(window as any).maestro.prompts.reset = vi
			.fn()
			.mockResolvedValueOnce({ success: true, content: '# reset' })
			.mockResolvedValueOnce({ success: false, error: 'reset failed' });
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
		await waitFor(() => {
			expect((window as any).maestro.prompts.reset).toHaveBeenCalledWith('maestro-system-prompt');
		});
		expect(screen.getByDisplayValue('# reset')).toBeInTheDocument();
		expect(screen.getByText('Reset to default')).toBeInTheDocument();

		vi.mocked(window.confirm).mockReturnValueOnce(false);
		fireEvent.change(screen.getByDisplayValue('# reset'), { target: { value: '# dirty reset' } });
		fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
		expect((window as any).maestro.prompts.reset).toHaveBeenCalledTimes(1);

		vi.mocked(window.confirm).mockReturnValueOnce(true);
		fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
		expect(await screen.findByText('reset failed')).toBeInTheDocument();
	});

	it('handles thrown reset errors', async () => {
		(window as any).maestro.prompts.reset = vi
			.fn()
			.mockRejectedValueOnce(new Error('reset exploded'));
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
		expect(await screen.findByText('Error: reset exploded')).toBeInTheDocument();
	});

	it('uses fallback reset errors for empty error responses and string throws', async () => {
		(window as any).maestro.prompts.reset = vi
			.fn()
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce('reset string');
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
		expect(await screen.findByText('Failed to reset prompt')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
		expect(await screen.findByText('reset string')).toBeInTheDocument();
	});

	it('shows bundled default drift view and handles bundled default failures', async () => {
		(window as any).maestro.prompts.getBundledDefault = vi
			.fn()
			.mockResolvedValueOnce({ success: true, content: '# bundled default' })
			.mockResolvedValueOnce({ success: false, error: 'default failed' })
			.mockRejectedValueOnce(new Error('default exploded'));
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(
			screen.getByTitle('View the current bundled default that shipped with this update')
		);
		expect(await screen.findByDisplayValue('# bundled default')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Exit default view (show your customization)'));
		expect(screen.getByDisplayValue('# system')).toBeInTheDocument();

		fireEvent.click(
			screen.getByTitle('View the current bundled default that shipped with this update')
		);
		expect(await screen.findByDisplayValue(/default failed/)).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Exit default view (show your customization)'));
		fireEvent.click(
			screen.getByTitle('View the current bundled default that shipped with this update')
		);
		expect(await screen.findByDisplayValue(/default exploded/)).toBeInTheDocument();
	});

	it('uses fallback bundled default errors for empty error responses and string throws', async () => {
		(window as any).maestro.prompts.getBundledDefault = vi
			.fn()
			.mockResolvedValueOnce({ success: false })
			.mockRejectedValueOnce('default string');
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.click(
			screen.getByTitle('View the current bundled default that shipped with this update')
		);
		expect(await screen.findByDisplayValue(/Failed to load bundled default/)).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Exit default view (show your customization)'));
		fireEvent.click(
			screen.getByTitle('View the current bundled default that shipped with this update')
		);
		expect(await screen.findByDisplayValue(/default string/)).toBeInTheDocument();
	});

	it('guards unsaved prompt selection and toggles categories', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		fireEvent.change(screen.getByDisplayValue('# system'), { target: { value: '# dirty' } });
		vi.mocked(window.confirm).mockReturnValueOnce(false);
		fireEvent.click(screen.getByRole('button', { name: /wizard-system/ }));
		expect(screen.getByRole('heading', { name: /^maestro-system-prompt/ })).toBeInTheDocument();

		vi.mocked(window.confirm).mockReturnValueOnce(true);
		fireEvent.click(screen.getByRole('button', { name: /wizard-system/ }));
		expect(await screen.findByRole('heading', { name: /^wizard-system/ })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Wizard' }));
		expect(screen.queryByRole('button', { name: /wizard-system/ })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Wizard' }));
		expect(screen.getByRole('button', { name: /wizard-system/ })).toBeInTheDocument();
	});

	it('reports load failure and thrown load errors', async () => {
		const { captureMessage, captureException } =
			await import('../../../../../renderer/utils/sentry');
		vi.mocked(captureMessage).mockClear();
		vi.mocked(captureException).mockClear();
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({
			success: false,
			error: 'load failed',
		}));
		const { unmount } = render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => {
			expect(captureMessage).toHaveBeenCalledWith('MaestroPromptsTab load failed: load failed', {
				extra: { error: 'load failed' },
			});
		});
		expect(screen.getByText('Select a prompt to edit')).toBeInTheDocument();

		unmount();
		setupWindowMaestro();
		(window as any).maestro.prompts.getAll = vi.fn(async () => {
			throw new Error('load exploded');
		});
		render(<MaestroPromptsTab theme={mockTheme} initialSelectedPromptId="wizard-system" />);
		await waitFor(() => {
			expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
				extra: { context: 'MaestroPromptsTab.loadPrompts' },
			});
		});
		expect(screen.getByText('Select a prompt to edit')).toBeInTheDocument();
	});

	it('handles default load errors, string throws, missing prompt paths, and empty inventories', async () => {
		const { captureMessage, captureException } =
			await import('../../../../../renderer/utils/sentry');
		vi.mocked(captureMessage).mockClear();
		vi.mocked(captureException).mockClear();
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({ success: false }));
		let rendered = render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => {
			expect(captureMessage).toHaveBeenCalledWith(
				'MaestroPromptsTab load failed: Failed to load prompts',
				{ extra: { error: undefined } }
			);
		});
		rendered.unmount();

		setupWindowMaestro();
		(window as any).maestro.prompts.getAll = vi.fn(async () => {
			throw 'load string';
		});
		rendered = render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => {
			expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
				extra: { context: 'MaestroPromptsTab.loadPrompts' },
			});
		});
		rendered.unmount();

		setupWindowMaestro();
		(window as any).maestro.prompts.getPath = vi.fn(async () => ({ success: false }));
		(window as any).maestro.prompts.getAll = vi.fn(async () => ({ success: true, prompts: [] }));
		render(<MaestroPromptsTab theme={mockTheme} />);
		expect(await screen.findByText('Select a prompt to edit')).toBeInTheDocument();
	});
});
