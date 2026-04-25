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
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';

const mockSetLastSelectedPromptId = vi.fn();
let mockLastSelectedPromptId: string | null = null;

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
	useActiveSession: () => null,
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
	useTemplateAutocomplete: () => ({
		handleChange: vi.fn(),
		handleKeyDown: vi.fn(),
		autocompleteRef: { current: null },
		autocompleteState: { isOpen: false },
		selectVariable: vi.fn(),
	}),
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
		isModified: false,
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
		setupWindowMaestro();
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
});
