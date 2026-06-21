import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenSpecCommandsPanel } from '../../renderer/components/OpenSpecCommandsPanel';
import { logger } from '../../renderer/utils/logger';
import type { OpenSpecCommand, OpenSpecMetadata, Theme } from '../../renderer/types';

const mockAutocompleteState = {
	isOpen: false,
	search: '',
	filteredVariables: [],
	selectedIndex: 0,
	position: { top: 0, left: 0 },
};

const mockHandleKeyDown = vi.fn().mockReturnValue(false);
const mockSelectVariable = vi.fn();
const mockAutocompleteRef = { current: null };

vi.mock('../../renderer/hooks', () => ({
	useSaveShortcut: vi.fn(),
	useTemplateAutocomplete: vi.fn((props: { onChange: (value: string) => void }) => ({
		autocompleteState: mockAutocompleteState,
		handleKeyDown: mockHandleKeyDown,
		handleChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
			props.onChange(event.target.value);
		},
		selectVariable: mockSelectVariable,
		autocompleteRef: mockAutocompleteRef,
	})),
}));

vi.mock('../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef<HTMLDivElement>((_props, ref) => (
		<div ref={ref} data-testid="template-autocomplete-dropdown" />
	)),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
		info: '#3794ff',
		textInverse: '#000000',
	},
};

const baseCommands: OpenSpecCommand[] = [
	{
		id: 'proposal',
		command: '/openspec.proposal',
		description: 'Create a change proposal',
		prompt: 'Draft a proposal for {{SELECTED_TEXT}}.',
		isCustom: false,
		isModified: false,
	},
	{
		id: 'implement',
		command: '/openspec.implement',
		description: 'Implement an approved proposal',
		prompt: `Custom implementation prompt ${'x'.repeat(520)}`,
		isCustom: true,
		isModified: true,
	},
];

const metadata: OpenSpecMetadata = {
	lastRefreshed: '2026-05-13T14:15:00.000Z',
	commitSha: 'abc123',
	sourceVersion: 'v1.2.3',
	sourceUrl: 'https://github.com/Fission-AI/OpenSpec',
};

const getPrompts = vi.fn();
const getMetadata = vi.fn();
const savePrompt = vi.fn();
const resetPrompt = vi.fn();
const refresh = vi.fn();
const openExternal = vi.fn();

const installMaestroMocks = () => {
	Object.assign(window, {
		maestro: {
			openspec: {
				getPrompts,
				getMetadata,
				savePrompt,
				resetPrompt,
				refresh,
			},
			shell: {
				openExternal,
			},
		},
	});
};

const renderPanel = () => render(<OpenSpecCommandsPanel theme={testTheme} />);

const getCommandRow = (command: string): HTMLElement => {
	const row = screen.getByText(command).closest('button');
	if (!row) {
		throw new Error(`No row found for ${command}`);
	}
	return row;
};

describe('OpenSpecCommandsPanel', () => {
	beforeEach(() => {
		installMaestroMocks();
		getPrompts.mockResolvedValue({ success: true, commands: baseCommands });
		getMetadata.mockResolvedValue({ success: true, metadata });
		savePrompt.mockResolvedValue({ success: true });
		resetPrompt.mockResolvedValue({ success: true, prompt: 'Restored bundled prompt.' });
		refresh.mockResolvedValue({
			success: true,
			metadata: { ...metadata, sourceVersion: 'v1.2.4' },
		});
		mockHandleKeyDown.mockReturnValue(false);
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('shows loading first, then renders metadata, commands, badges, and external link', async () => {
		renderPanel();

		expect(screen.getByText('Loading OpenSpec commands...')).toBeInTheDocument();

		await screen.findByText('/openspec.proposal');

		expect(getPrompts).toHaveBeenCalledTimes(1);
		expect(getMetadata).toHaveBeenCalledTimes(1);
		expect(screen.getByText('OpenSpec Commands')).toBeInTheDocument();
		expect(screen.getByText('v1.2.3')).toBeInTheDocument();
		expect(screen.getByText('May 13, 2026')).toBeInTheDocument();
		expect(screen.getByText('/openspec.implement')).toBeInTheDocument();
		expect(screen.getByText('Maestro')).toBeInTheDocument();
		expect(screen.getByText('Modified')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Fission-AI\/OpenSpec/u }));

		expect(openExternal).toHaveBeenCalledWith('https://github.com/Fission-AI/OpenSpec');
	});

	it('renders the empty state when no commands load', async () => {
		getPrompts.mockResolvedValue({ success: true, commands: [] });
		getMetadata.mockResolvedValue({ success: false });

		renderPanel();

		expect(await screen.findByText('No OpenSpec commands loaded')).toBeInTheDocument();
		expect(screen.queryByText('Version:')).not.toBeInTheDocument();
	});

	it('falls back to the raw refresh date when locale formatting fails', async () => {
		vi.spyOn(Date.prototype, 'toLocaleDateString').mockImplementationOnce(() => {
			throw new Error('date formatting failed');
		});
		getMetadata.mockResolvedValue({
			success: true,
			metadata: { ...metadata, lastRefreshed: 'raw-date-value' },
		});

		renderPanel();

		expect(await screen.findByText('raw-date-value')).toBeInTheDocument();
	});

	it('handles unsuccessful prompt payloads without rendering stale commands', async () => {
		getPrompts.mockResolvedValue({ success: false });

		renderPanel();

		expect(await screen.findByText('No OpenSpec commands loaded')).toBeInTheDocument();
		expect(screen.getByText('v1.2.3')).toBeInTheDocument();
	});

	it('expands, collapses, truncates long prompts, and resets modified prompts', async () => {
		renderPanel();

		await screen.findByText('/openspec.implement');
		fireEvent.click(getCommandRow('/openspec.implement'));

		expect(screen.getByTestId('chevrondown-icon')).toBeInTheDocument();
		expect(screen.getByText(/^Custom implementation prompt/).textContent).toHaveLength(503);
		expect(screen.getByTitle('Reset to bundled default')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Reset to bundled default'));

		await waitFor(() => {
			expect(resetPrompt).toHaveBeenCalledWith('implement');
		});
		expect(screen.getByText('Restored bundled prompt.')).toBeInTheDocument();
		expect(screen.queryByText('Modified')).not.toBeInTheDocument();

		fireEvent.click(getCommandRow('/openspec.implement'));

		expect(screen.queryByText('Restored bundled prompt.')).not.toBeInTheDocument();
	});

	it('edits, inserts a tab, saves, and cancels prompt edits', async () => {
		renderPanel();

		await screen.findByText('/openspec.proposal');
		fireEvent.click(getCommandRow('/openspec.proposal'));
		fireEvent.click(screen.getByTitle('Edit prompt'));

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Updated prompt' } });
		(textarea as HTMLTextAreaElement).selectionStart = 7;
		(textarea as HTMLTextAreaElement).selectionEnd = 8;
		fireEvent.keyDown(textarea, { key: 'Tab' });

		expect(mockHandleKeyDown).toHaveBeenCalled();
		expect(textarea).toHaveValue('Updated\tprompt');

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect(savePrompt).toHaveBeenCalledWith('proposal', 'Updated\tprompt');
		});
		expect(
			screen.getByText((_, element) => element?.textContent === 'Updated\tprompt')
		).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Edit prompt'));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Discard me' } });
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
		expect(screen.queryByText('Discard me')).not.toBeInTheDocument();
	});

	it('lets template autocomplete consume edit keydown events', async () => {
		mockHandleKeyDown.mockReturnValue(true);
		renderPanel();

		await screen.findByText('/openspec.proposal');
		fireEvent.click(getCommandRow('/openspec.proposal'));
		fireEvent.click(screen.getByTitle('Edit prompt'));

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Autocomplete value' } });
		fireEvent.keyDown(textarea, { key: 'Tab' });

		expect(textarea).toHaveValue('Autocomplete value');
		expect(screen.getByTestId('template-autocomplete-dropdown')).toBeInTheDocument();
	});

	it('ignores non-Tab edit keydown events after autocomplete declines them', async () => {
		renderPanel();

		await screen.findByText('/openspec.proposal');
		fireEvent.click(getCommandRow('/openspec.proposal'));
		fireEvent.click(screen.getByTitle('Edit prompt'));

		const textarea = screen.getByRole('textbox');
		fireEvent.change(textarea, { target: { value: 'Keep value' } });
		fireEvent.keyDown(textarea, { key: 'Enter' });

		expect(mockHandleKeyDown).toHaveBeenCalled();
		expect(textarea).toHaveValue('Keep value');
	});

	it('refreshes metadata and reloads prompts', async () => {
		getPrompts
			.mockResolvedValueOnce({ success: true, commands: baseCommands })
			.mockResolvedValueOnce({
				success: true,
				commands: [
					{
						...baseCommands[0],
						id: 'refreshed',
						command: '/openspec.refreshed',
						description: 'Refreshed command',
					},
				],
			});
		renderPanel();

		await screen.findByText('/openspec.proposal');
		fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

		expect(screen.getByRole('button', { name: 'Checking...' })).toBeDisabled();
		await screen.findByText('/openspec.refreshed');

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(screen.getByText('v1.2.4')).toBeInTheDocument();
	});

	it('keeps existing commands when refresh metadata succeeds but prompt reload fails', async () => {
		getPrompts
			.mockResolvedValueOnce({ success: true, commands: baseCommands })
			.mockResolvedValueOnce({ success: false });
		renderPanel();

		await screen.findByText('/openspec.proposal');
		fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

		await waitFor(() => {
			expect(refresh).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByText('v1.2.4')).toBeInTheDocument();
		expect(screen.getByText('/openspec.proposal')).toBeInTheDocument();
	});

	it('logs load, save, reset, and refresh failures without throwing', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
		getPrompts.mockRejectedValueOnce(new Error('load failed'));
		const { unmount } = renderPanel();

		expect(await screen.findByText('No OpenSpec commands loaded')).toBeInTheDocument();
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to load openspec commands:',
			undefined,
			expect.any(Error)
		);

		unmount();
		getPrompts.mockResolvedValue({ success: true, commands: baseCommands });
		savePrompt.mockRejectedValueOnce(new Error('save failed'));
		resetPrompt.mockRejectedValueOnce(new Error('reset failed'));
		refresh.mockRejectedValueOnce(new Error('refresh failed'));
		renderPanel();

		await screen.findByText('/openspec.implement');
		fireEvent.click(getCommandRow('/openspec.implement'));
		fireEvent.click(screen.getByTitle('Edit prompt'));
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to save prompt:',
				undefined,
				expect.any(Error)
			);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByTitle('Reset to bundled default'));

		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to reset prompt:',
				undefined,
				expect.any(Error)
			);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to refresh openspec prompts:',
				undefined,
				expect.any(Error)
			);
		});
	});

	it('leaves state unchanged for unsuccessful save, reset, and refresh responses', async () => {
		savePrompt.mockResolvedValueOnce({ success: false });
		resetPrompt.mockResolvedValueOnce({ success: true });
		refresh.mockResolvedValueOnce({ success: false });
		renderPanel();

		await screen.findByText('/openspec.implement');
		fireEvent.click(getCommandRow('/openspec.implement'));
		fireEvent.click(screen.getByTitle('Edit prompt'));
		fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Unsaved prompt' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() => {
			expect(savePrompt).toHaveBeenCalledWith('implement', 'Unsaved prompt');
		});
		expect(screen.getByRole('textbox')).toHaveValue('Unsaved prompt');

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		fireEvent.click(screen.getByTitle('Reset to bundled default'));

		await waitFor(() => {
			expect(resetPrompt).toHaveBeenCalledWith('implement');
		});
		expect(screen.getByText(/^Custom implementation prompt/)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Check for Updates' }));

		await waitFor(() => {
			expect(refresh).toHaveBeenCalledTimes(1);
		});
		expect(screen.getByText('v1.2.3')).toBeInTheDocument();
	});
});
