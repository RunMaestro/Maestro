/**
 * Tests for ComposerOptionsSheet - the phone composer's "..." panel. Every
 * setting the desktop toolbar spreads across a row of pills lives here as an
 * expandable section, because a row of pills does not fit at 390px and
 * tap-to-cycle is a poor control for a three-state setting on a touchscreen.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerOptionsSheet } from '../../../../renderer/components/InputArea/components/ComposerOptionsSheet';
import { mockTheme } from '../../../helpers/mockTheme';

function renderSheet(overrides: Partial<React.ComponentProps<typeof ComposerOptionsSheet>> = {}) {
	const props: React.ComponentProps<typeof ComposerOptionsSheet> = {
		open: true,
		onClose: vi.fn(),
		theme: mockTheme,
		agentId: 'codex',
		tabSaveToHistory: false,
		onToggleTabSaveToHistory: vi.fn(),
		hasReadOnlyCapability: true,
		hasStandardCapability: true,
		permissionMode: 'full',
		onPermissionModeChange: vi.fn(),
		supportsThinking: true,
		tabShowThinking: 'off',
		onThinkingModeChange: vi.fn(),
		currentModel: 'gpt-5',
		availableModels: ['gpt-5', 'gpt-5-mini'],
		onModelChange: vi.fn(),
		currentEffort: 'high',
		availableEfforts: ['', 'low', 'medium', 'high'],
		onEffortChange: vi.fn(),
		...overrides,
	};
	return { ...props, ...render(<ComposerOptionsSheet {...props} />) };
}

describe('ComposerOptionsSheet', () => {
	it('renders nothing while closed', () => {
		renderSheet({ open: false });
		expect(screen.queryByTestId('composer-options-sheet')).not.toBeInTheDocument();
	});

	it('opens at half the viewport height', () => {
		// Half a screen, so an expanded model list is usable without the sheet
		// swallowing the conversation behind it.
		renderSheet();
		expect(screen.getByRole('dialog').style.maxHeight).toBe('50dvh');
	});

	it('lists every setting collapsed by default', () => {
		renderSheet();
		expect(screen.getByTestId('composer-options-history')).toBeInTheDocument();
		for (const id of ['access', 'thinking', 'effort', 'model']) {
			expect(screen.getByTestId(`composer-options-${id}`)).toHaveAttribute(
				'aria-expanded',
				'false'
			);
		}
	});

	it('shows the current value on each collapsed section', () => {
		renderSheet();
		expect(screen.getByTestId('composer-options-model')).toHaveTextContent('gpt-5');
		expect(screen.getByTestId('composer-options-effort')).toHaveTextContent('high');
		expect(screen.getByTestId('composer-options-history')).toHaveTextContent('Off');
	});

	it('toggles History without expanding anything', () => {
		const onToggleTabSaveToHistory = vi.fn();
		renderSheet({ onToggleTabSaveToHistory });
		fireEvent.click(screen.getByTestId('composer-options-history'));
		expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(1);
	});

	it('expands the model list and reports a pick', () => {
		const onModelChange = vi.fn();
		renderSheet({ onModelChange });
		fireEvent.click(screen.getByTestId('composer-options-model'));
		expect(screen.getByTestId('composer-options-model')).toHaveAttribute('aria-expanded', 'true');
		fireEvent.click(screen.getByRole('button', { name: /gpt-5-mini/ }));
		expect(onModelChange).toHaveBeenCalledWith('gpt-5-mini');
	});

	it('offers a (default) model even when the list omits the empty entry', () => {
		const onModelChange = vi.fn();
		renderSheet({ onModelChange, availableModels: ['gpt-5'] });
		fireEvent.click(screen.getByTestId('composer-options-model'));
		fireEvent.click(screen.getByRole('button', { name: '(default)' }));
		expect(onModelChange).toHaveBeenCalledWith('');
	});

	// Auto is in `availableModels` like any model (the toolbar adds it for an
	// agent it can act on); the sheet's part is to draw the word as "Auto" and to
	// say under it what it does.
	describe('the Auto model choice', () => {
		const AUTO_TITLE = 'Auto: picks the model and the effort for each turn. Decided by System One.';

		it('reads Auto on the collapsed section while Auto is the model', () => {
			renderSheet({ currentModel: 'auto', availableModels: ['', 'auto', 'gpt-5'] });
			expect(screen.getByTestId('composer-options-model')).toHaveTextContent('Auto');
			expect(screen.getByTestId('composer-options-model')).not.toHaveTextContent('auto');
		});

		it('lists Auto with what it does beneath it, and reports the word', () => {
			const onModelChange = vi.fn();
			renderSheet({
				onModelChange,
				availableModels: ['', 'auto', 'gpt-5'],
				autoModelTitle: AUTO_TITLE,
			});
			fireEvent.click(screen.getByTestId('composer-options-model'));

			const row = screen.getByRole('button', { name: /^Auto/ });
			expect(row).toHaveTextContent(AUTO_TITLE);
			fireEvent.click(row);
			expect(onModelChange).toHaveBeenCalledWith('auto');
		});

		it('describes the Auto row alone', () => {
			renderSheet({ availableModels: ['', 'auto', 'gpt-5'], autoModelTitle: AUTO_TITLE });
			fireEvent.click(screen.getByTestId('composer-options-model'));

			expect(screen.getAllByText(AUTO_TITLE)).toHaveLength(1);
			expect(screen.getByRole('button', { name: 'gpt-5' })).not.toHaveTextContent(AUTO_TITLE);
		});

		it('lists no Auto when the list it is handed has none', () => {
			renderSheet({ autoModelTitle: AUTO_TITLE });
			fireEvent.click(screen.getByTestId('composer-options-model'));

			expect(screen.queryByRole('button', { name: /^Auto/ })).not.toBeInTheDocument();
			expect(screen.queryByText(AUTO_TITLE)).not.toBeInTheDocument();
		});
	});

	it('names an effort rather than stepping to the next one', () => {
		const onEffortChange = vi.fn();
		renderSheet({ onEffortChange });
		fireEvent.click(screen.getByTestId('composer-options-effort'));
		fireEvent.click(screen.getByRole('button', { name: 'low' }));
		expect(onEffortChange).toHaveBeenCalledWith('low');
	});

	it('names a thinking mode rather than cycling it', () => {
		const onThinkingModeChange = vi.fn();
		renderSheet({ onThinkingModeChange, tabShowThinking: 'off' });
		fireEvent.click(screen.getByTestId('composer-options-thinking'));
		// Cycling from 'off' would reach 'sticky' only on the second tap.
		fireEvent.click(screen.getByRole('button', { name: 'Sticky' }));
		expect(onThinkingModeChange).toHaveBeenCalledWith('sticky');
	});

	it('keeps only one section open at a time', () => {
		// The panel is half a screen; a second open list would sit below the fold
		// with no sign it is there.
		renderSheet();
		fireEvent.click(screen.getByTestId('composer-options-model'));
		fireEvent.click(screen.getByTestId('composer-options-effort'));
		expect(screen.getByTestId('composer-options-model')).toHaveAttribute('aria-expanded', 'false');
		expect(screen.getByTestId('composer-options-effort')).toHaveAttribute('aria-expanded', 'true');
	});

	it('collapses a section when its header is tapped again', () => {
		renderSheet();
		const model = screen.getByTestId('composer-options-model');
		fireEvent.click(model);
		fireEvent.click(model);
		expect(model).toHaveAttribute('aria-expanded', 'false');
	});

	it('hides Standard for an agent with no working relay', () => {
		// Offering it would let the user pick a mode whose tool approvals never
		// arrive.
		renderSheet({ hasStandardCapability: false });
		fireEvent.click(screen.getByTestId('composer-options-access'));
		expect(screen.queryByRole('button', { name: 'Standard' })).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Full Access' })).toBeInTheDocument();
	});

	it('omits sections the agent does not support', () => {
		renderSheet({
			hasReadOnlyCapability: false,
			supportsThinking: false,
			availableEfforts: [''],
			availableModels: [],
		});
		expect(screen.queryByTestId('composer-options-access')).not.toBeInTheDocument();
		expect(screen.queryByTestId('composer-options-thinking')).not.toBeInTheDocument();
		expect(screen.queryByTestId('composer-options-effort')).not.toBeInTheDocument();
		expect(screen.queryByTestId('composer-options-model')).not.toBeInTheDocument();
	});
});
