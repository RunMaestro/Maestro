/**
 * Tests for SpecKitCommandsPanel.tsx
 *
 * Focus: the disabled-section behavior shared by the bundled command panels
 * (Spec Kit / OpenSpec / BMAD). When a section is toggled off, its slash
 * commands collapse out of view behind a "Show anyway" notice.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SpecKitCommandsPanel } from '../../../renderer/components/SpecKitCommandsPanel';
import type { Theme } from '../../../renderer/types';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/hooks/input/useTemplateAutocomplete', () => ({
	useTemplateAutocomplete: () => ({
		autocompleteState: { isOpen: false, search: '', filteredVariables: [], selectedIndex: 0 },
		handleKeyDown: vi.fn().mockReturnValue(false),
		handleChange: vi.fn(),
		selectVariable: vi.fn(),
		closeAutocomplete: vi.fn(),
		autocompleteRef: { current: null },
	}),
}));

vi.mock('../../../renderer/components/TemplateAutocompleteDropdown', () => ({
	TemplateAutocompleteDropdown: React.forwardRef((_props: { theme: Theme }, ref) => (
		<div ref={ref as React.Ref<HTMLDivElement>} />
	)),
}));

const mockCommands = [
	{
		id: 'speckit-specify',
		command: '/speckit.specify',
		description: 'Create a specification',
		prompt: 'Specify prompt',
		isModified: false,
	},
	{
		id: 'speckit-plan',
		command: '/speckit.plan',
		description: 'Plan the work',
		prompt: 'Plan prompt',
		isModified: false,
	},
];

const renderPanel = (enabled: boolean, onEnabledChange = vi.fn()) =>
	render(
		<SpecKitCommandsPanel theme={mockTheme} enabled={enabled} onEnabledChange={onEnabledChange} />
	);

describe('SpecKitCommandsPanel', () => {
	beforeEach(() => {
		(window as unknown as { maestro: Record<string, unknown> }).maestro = {
			...(window as unknown as { maestro: Record<string, unknown> }).maestro,
			speckit: {
				getPrompts: vi.fn().mockResolvedValue({ success: true, commands: mockCommands }),
				getMetadata: vi.fn().mockResolvedValue({
					success: true,
					metadata: { sourceVersion: '1.2.3', lastRefreshed: '2026-01-13T00:00:00.000Z' },
				}),
				savePrompt: vi.fn().mockResolvedValue({ success: true }),
				resetPrompt: vi.fn().mockResolvedValue({ success: true, prompt: 'Specify prompt' }),
				refresh: vi.fn().mockResolvedValue({ success: true, metadata: null }),
			},
		};
	});

	it('lists the commands while the section is enabled', async () => {
		renderPanel(true);

		expect(await screen.findByText('/speckit.specify')).toBeInTheDocument();
		expect(screen.getByText('/speckit.plan')).toBeInTheDocument();
		expect(screen.queryByText(/commands hidden/)).not.toBeInTheDocument();
	});

	it('collapses the command list when the section is disabled', async () => {
		renderPanel(false);

		expect(await screen.findByText('2 Spec Kit commands hidden')).toBeInTheDocument();
		expect(screen.queryByText('/speckit.specify')).not.toBeInTheDocument();
		// The version/refresh row is part of the collapsed body too
		expect(screen.queryByText('Check for Updates')).not.toBeInTheDocument();
	});

	it('reveals the collapsed commands on demand and collapses again', async () => {
		renderPanel(false);

		const notice = await screen.findByText('2 Spec Kit commands hidden');
		fireEvent.click(notice);

		expect(await screen.findByText('/speckit.specify')).toBeInTheDocument();
		expect(screen.getByText('Collapse')).toBeInTheDocument();

		fireEvent.click(screen.getByText('2 Spec Kit commands hidden'));
		await waitFor(() => {
			expect(screen.queryByText('/speckit.specify')).not.toBeInTheDocument();
		});
	});

	it('re-collapses a revealed list when the section is toggled off again', async () => {
		const { rerender } = renderPanel(false);

		fireEvent.click(await screen.findByText('2 Spec Kit commands hidden'));
		expect(await screen.findByText('/speckit.specify')).toBeInTheDocument();

		// Enable, then disable again: the reveal should not persist
		rerender(<SpecKitCommandsPanel theme={mockTheme} enabled={true} onEnabledChange={vi.fn()} />);
		rerender(<SpecKitCommandsPanel theme={mockTheme} enabled={false} onEnabledChange={vi.fn()} />);

		await waitFor(() => {
			expect(screen.queryByText('/speckit.specify')).not.toBeInTheDocument();
		});
		expect(screen.getByText('Show anyway')).toBeInTheDocument();
	});

	it('toggling the switch reports the new enabled state', async () => {
		const onEnabledChange = vi.fn();
		renderPanel(true, onEnabledChange);

		await screen.findByText('/speckit.specify');
		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Show Spec Kit commands in slash command autocomplete',
			})
		);

		expect(onEnabledChange).toHaveBeenCalledWith(false);
	});
});
