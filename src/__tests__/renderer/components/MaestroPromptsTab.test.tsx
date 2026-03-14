// ABOUTME: Unit tests for the MaestroPromptsTab component.
// ABOUTME: Tests prompt loading, selection, editing, saving, resetting, and category grouping.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { MaestroPromptsTab } from '../../../renderer/components/MaestroPromptsTab';
import type { Theme } from '../../../renderer/types';

const { mockReloadRendererPrompts } = vi.hoisted(() => ({
	mockReloadRendererPrompts: vi.fn(),
}));

vi.mock('../../../renderer/services/promptInit', () => ({
	reloadRendererPrompts: mockReloadRendererPrompts,
}));

const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#2d2d30',
		textMain: '#cccccc',
		textDim: '#808080',
		textFaint: '#555555',
		accent: '#007acc',
		border: '#3c3c3c',
		error: '#f44747',
		warning: '#cca700',
		success: '#4caf50',
		info: '#3794ff',
		selection: '#264f78',
	},
};

const mockPrompts = [
	{
		id: 'wizard-system',
		filename: 'wizard-system.md',
		description: 'Main wizard system prompt',
		category: 'wizard',
		content: 'Wizard system content',
		isModified: false,
	},
	{
		id: 'wizard-iterate',
		filename: 'wizard-iterate.md',
		description: 'Wizard iterate prompt',
		category: 'wizard',
		content: 'Wizard iterate content',
		isModified: true,
	},
	{
		id: 'autorun-default',
		filename: 'autorun-default.md',
		description: 'Default Auto Run prompt',
		category: 'autorun',
		content: 'Auto run content',
		isModified: false,
	},
];

const mockPromptsApi = {
	getAll: vi.fn(),
	get: vi.fn(),
	getAllIds: vi.fn(),
	save: vi.fn(),
	reset: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	mockReloadRendererPrompts.mockResolvedValue(undefined);
	// Add prompts namespace to existing window.maestro mock
	(window as any).maestro.prompts = mockPromptsApi;
});

afterEach(() => {
	cleanup();
});

describe('MaestroPromptsTab', () => {
	describe('loading state', () => {
		it('should show loading text while prompts are being fetched', () => {
			mockPromptsApi.getAll.mockReturnValue(new Promise(() => {}));
			render(<MaestroPromptsTab theme={mockTheme} />);
			expect(screen.getByText('Loading prompts...')).toBeTruthy();
		});
	});

	describe('error handling', () => {
		it('should display error when getAll fails', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: false,
				error: 'Failed to load',
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Failed to load')).toBeTruthy();
			});
		});

		it('should display error when getAll throws', async () => {
			mockPromptsApi.getAll.mockRejectedValue(new Error('Network error'));

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Error: Network error')).toBeTruthy();
			});
		});
	});

	describe('prompt list', () => {
		it('should render prompts grouped by category', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Wizard')).toBeTruthy();
				expect(screen.getByText('Auto Run')).toBeTruthy();
			});
		});

		it('should display prompt IDs in the list', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			// Wait for prompts to load by checking for category header first
			await waitFor(() => {
				expect(screen.getByText('Wizard')).toBeTruthy();
			});

			// The selected prompt ID appears both in list and editor header,
			// so use getAllByText. The non-selected ones appear once.
			expect(screen.getAllByText('wizard-system').length).toBeGreaterThanOrEqual(1);
			expect(screen.getByText('wizard-iterate')).toBeTruthy();
			expect(screen.getByText('autorun-default')).toBeTruthy();
		});

		it('should select first prompt by default', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('Main wizard system prompt')).toBeTruthy();
			});
		});
	});

	describe('prompt selection', () => {
		it('should display selected prompt content in editor', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('autorun-default')).toBeTruthy();
			});

			fireEvent.click(screen.getByText('autorun-default'));

			expect(screen.getByText('Default Auto Run prompt')).toBeTruthy();
			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			expect(textarea.value).toBe('Auto run content');
		});
	});

	describe('editing', () => {
		it('should enable Save button when content changes', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toBeTruthy();
			});

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			const saveButton = screen.getByText('Save').closest('button')!;

			expect(saveButton.disabled).toBe(true);

			fireEvent.change(textarea, { target: { value: 'Modified content' } });

			expect(saveButton.disabled).toBe(false);
		});
	});

	describe('saving', () => {
		it('should call prompts.save and show success message', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});
			mockPromptsApi.save.mockResolvedValue({ success: true });

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toBeTruthy();
			});

			fireEvent.change(screen.getByRole('textbox'), {
				target: { value: 'Modified content' },
			});
			fireEvent.click(screen.getByText('Save'));

			expect(mockPromptsApi.save).toHaveBeenCalledWith('wizard-system', 'Modified content');

			await waitFor(() => {
				expect(screen.getByText('Changes saved and applied')).toBeTruthy();
			});
		});

		it('should show error when save fails', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});
			mockPromptsApi.save.mockResolvedValue({ success: false, error: 'Write failed' });

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toBeTruthy();
			});

			fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New' } });
			fireEvent.click(screen.getByText('Save'));

			await waitFor(() => {
				expect(screen.getByText('Write failed')).toBeTruthy();
			});
		});
	});

	describe('resetting', () => {
		it('should call prompts.reset and update content', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});
			mockPromptsApi.reset.mockResolvedValue({
				success: true,
				content: 'Original wizard iterate content',
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('wizard-iterate')).toBeTruthy();
			});

			// Select the modified prompt
			fireEvent.click(screen.getByText('wizard-iterate'));

			expect(screen.getByText('Modified')).toBeTruthy();

			const resetButton = screen.getByText('Reset to Default').closest('button')!;
			expect(resetButton.disabled).toBe(false);

			fireEvent.click(resetButton);

			expect(mockPromptsApi.reset).toHaveBeenCalledWith('wizard-iterate');

			await waitFor(() => {
				expect(screen.getByText('Prompt reset to default')).toBeTruthy();
			});
		});

		it('should disable Reset button for unmodified prompts', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByRole('textbox')).toBeTruthy();
			});

			const resetButton = screen.getByText('Reset to Default').closest('button')!;
			expect(resetButton.disabled).toBe(true);
		});
	});

	describe('modified indicator', () => {
		it('should show modified indicator dot for customized prompts', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				expect(screen.getByText('wizard-iterate')).toBeTruthy();
			});

			const modifiedItem = screen.getByText('wizard-iterate').closest('button')!;
			expect(modifiedItem.innerHTML).toContain('•');
		});
	});

	describe('category collapsing', () => {
		it('should toggle category visibility when clicking category header', async () => {
			mockPromptsApi.getAll.mockResolvedValue({
				success: true,
				prompts: mockPrompts,
			});

			render(<MaestroPromptsTab theme={mockTheme} />);

			await waitFor(() => {
				// wizard-iterate only shows in the list (not editor header since wizard-system is selected)
				expect(screen.getByText('wizard-iterate')).toBeTruthy();
			});

			// Click on "Wizard" category header to collapse
			fireEvent.click(screen.getByText('Wizard'));

			// wizard-iterate should be hidden from the list
			expect(screen.queryByText('wizard-iterate')).toBeNull();

			// Other category still visible
			expect(screen.getByText('autorun-default')).toBeTruthy();

			// Click again to expand
			fireEvent.click(screen.getByText('Wizard'));
			expect(screen.getByText('wizard-iterate')).toBeTruthy();
		});
	});
});
