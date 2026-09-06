/**
 * Tests for MaestroPromptsTab - selection precedence and persistence.
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

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';

/**
 * The real edit surface is CodeMirror 6, which needs a layout engine jsdom does
 * not have. Standing in a plain textarea keeps these tests about the wiring the
 * tab owns - which prompt is selected, which mode is showing, what the filter
 * narrows to - and matches how the FilePreview and Memory Viewer suites stub
 * the same module.
 */
vi.mock('../../../../../renderer/components/FilePreview/markdownEditor', () => ({
	MarkdownEditor: React.forwardRef<
		{ focus(): void; setSearchMatches(m: unknown[], i: number): void },
		{ value: string; onChange: (v: string) => void; readOnly?: boolean }
	>(({ value, onChange, readOnly }, ref) => {
		const areaRef = React.useRef<HTMLTextAreaElement>(null);
		React.useImperativeHandle(ref, () => ({
			focus: () => areaRef.current?.focus(),
			setSearchMatches: () => {},
		}));
		return (
			<textarea
				ref={areaRef}
				value={value}
				readOnly={readOnly}
				onChange={(e) => onChange(e.target.value)}
			/>
		);
	}),
}));

const mockSetLastSelectedPromptId = vi.fn();
let mockLastSelectedPromptId: string | null = null;

vi.mock('../../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: vi.fn((selector: (s: unknown) => unknown) =>
		selector({
			conductorProfile: '',
			lastSelectedPromptId: mockLastSelectedPromptId,
			setLastSelectedPromptId: mockSetLastSelectedPromptId,
			shortcuts: { toggleMarkdownMode: { keys: ['Meta', 'e'] } },
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

vi.mock('../../../../../renderer/hooks/input/useEditorTemplateAutocomplete', () => ({
	useEditorTemplateAutocomplete: ({ onChange }: { onChange: (value: string) => void }) => ({
		handleChange: onChange,
		handleKeyDown: vi.fn(() => false),
		autocompleteRef: { current: null },
		autocompleteState: { isOpen: false },
		selectVariable: vi.fn(),
		closeAutocomplete: vi.fn(),
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

	it('narrows the list by prompt body, not just by name', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		// "# wizard" appears only in the wizard prompt's CONTENT - its id and
		// description would not match a body-only query.
		fireEvent.change(screen.getByRole('textbox', { name: /filter prompts/i }), {
			target: { value: '# wizard' },
		});

		await waitFor(() => {
			expect(screen.queryByRole('button', { name: /autorun-default/ })).not.toBeInTheDocument();
		});
		expect(screen.getByRole('button', { name: /wizard-system/ })).toBeInTheDocument();
	});

	it('keeps a prompt with unsaved edits in the list even when the filter excludes it', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		// Edit the selected prompt, then filter to something it cannot match.
		const editor = screen.getByRole('textbox', { name: '' });
		fireEvent.change(editor, { target: { value: '# system edited' } });
		fireEvent.change(screen.getByRole('textbox', { name: /filter prompts/i }), {
			target: { value: 'wizard' },
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /wizard-system/ })).toBeInTheDocument();
		});
		// Still listed, and still the open document - an unsaved draft must not
		// be filtered off the screen.
		expect(screen.getByRole('button', { name: /maestro-system-prompt/ })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: /^maestro-system-prompt/ })).toBeInTheDocument();
	});

	it('opens on the source editor and flips to the rendered prompt on Cmd+E', async () => {
		render(<MaestroPromptsTab theme={mockTheme} />);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));
		expect(screen.queryByTestId('prompt-preview')).not.toBeInTheDocument();

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', metaKey: true }));
		});

		await waitFor(() => expect(screen.getByTestId('prompt-preview')).toBeInTheDocument());
	});

	it('reports Escape as handled while the filter has text, and clears it', async () => {
		let escapeHandler: (() => boolean) | null = null;
		render(
			<MaestroPromptsTab
				theme={mockTheme}
				onEscapeHandled={(handler) => {
					escapeHandler = handler;
				}}
			/>
		);
		await waitFor(() => screen.getByRole('heading', { name: /^maestro-system-prompt/ }));

		const filter = screen.getByRole('textbox', { name: /filter prompts/i });
		fireEvent.change(filter, { target: { value: 'wizard' } });

		// Rung 2 of the ladder: focus is in the filter box, so the first Escape
		// hands focus back to the list and keeps the query.
		filter.focus();
		expect(escapeHandler).toBeTruthy();
		act(() => {
			expect(escapeHandler!()).toBe(true);
		});
		expect((filter as HTMLInputElement).value).toBe('wizard');

		// Rung 3: the query itself.
		act(() => {
			expect(escapeHandler!()).toBe(true);
		});
		await waitFor(() => expect((filter as HTMLInputElement).value).toBe(''));

		// Nothing left to back out of - Settings gets to close.
		act(() => {
			expect(escapeHandler!()).toBe(false);
		});
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
