/**
 * Tests for ComposerOptionsSheet - the phone composer's "..." panel. Every
 * setting the desktop toolbar spreads across a row of pills lives here as an
 * expandable section, because a row of pills does not fit at 390px and
 * tap-to-cycle is a poor control for a three-state setting on a touchscreen.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerOptionsSheet } from '../../../../renderer/components/InputArea/components/ComposerOptionsSheet';
import { AGENT_CAPABILITIES } from '../../../../shared/maestro-lib/providers/capabilities';
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
	it('keeps Run on configuration out of the quick model section on phones', () => {
		renderSheet();
		fireEvent.click(screen.getByTestId('composer-options-model'));
		expect(screen.queryByText('Run on')).not.toBeInTheDocument();
		expect(screen.queryByTestId('composer-run-on')).not.toBeInTheDocument();
	});

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

	it('names the Run on target and explains the override while keeping Auto selectable', () => {
		const onModelChange = vi.fn();
		renderSheet({
			runOn: 'qwen3:latest · Ollama',
			availableModels: ['', 'auto', 'gpt-5'],
			onModelChange,
		});
		const model = screen.getByTestId('composer-options-model');
		expect(model).toHaveTextContent('qwen3:latest · Ollama');
		expect(model).not.toHaveTextContent('gpt-5');
		fireEvent.click(model);
		expect(screen.getByText(/This target overrides named provider models/)).toHaveTextContent(
			'Change Run on in Edit Agent > Models.'
		);
		fireEvent.click(screen.getByRole('button', { name: 'Auto' }));
		expect(onModelChange).toHaveBeenCalledWith('auto');
	});

	it('shows the Run on target and its explanation without provider model discovery', () => {
		renderSheet({
			runOn: 'qwen3:latest · Ollama',
			availableModels: [],
			onModelChange: undefined,
		});
		fireEvent.click(screen.getByTestId('composer-options-model'));
		expect(screen.getByText(/Run on: qwen3:latest · Ollama/)).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: '(default)' })).not.toBeInTheDocument();
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

	it.each(['full', 'standard', 'readonly'] as const)(
		'offers Grok full/standard/read-only choices from %s and dispatches the selected mode',
		(permissionMode) => {
			// Standard runs on the local ACP route, so the sheet offers it.
			expect(AGENT_CAPABILITIES.grok.supportsStandardPermissionMode).toBe(true);
			const { onPermissionModeChange } = renderSheet({
				agentId: 'grok',
				permissionMode,
				hasReadOnlyCapability: AGENT_CAPABILITIES.grok.supportsReadOnlyMode,
				hasStandardCapability: AGENT_CAPABILITIES.grok.supportsStandardPermissionMode ?? false,
			});
			fireEvent.click(screen.getByTestId('composer-options-access'));

			const full = screen.getByRole('button', { name: 'Full Access' });
			const standard = screen.getByRole('button', { name: 'Standard' });
			const readonly = screen.getByRole('button', { name: 'Read-Only' });
			expect(full).toHaveAttribute('aria-pressed', String(permissionMode === 'full'));
			expect(standard).toHaveAttribute('aria-pressed', String(permissionMode === 'standard'));
			expect(readonly).toHaveAttribute('aria-pressed', String(permissionMode === 'readonly'));
			expect(screen.queryByRole('button', { name: /ACP|Plan/i })).not.toBeInTheDocument();
			expect(onPermissionModeChange).not.toHaveBeenCalled();

			fireEvent.click(standard);
			fireEvent.click(readonly);
			fireEvent.click(full);
			expect(onPermissionModeChange).toHaveBeenCalledTimes(3);
			expect(onPermissionModeChange).toHaveBeenNthCalledWith(1, 'standard');
			expect(onPermissionModeChange).toHaveBeenNthCalledWith(2, 'readonly');
			expect(onPermissionModeChange).toHaveBeenNthCalledWith(3, 'full');
		}
	);

	it.each(['full', 'readonly'] as const)(
		'hides unavailable Grok access controls even with stored %s mode',
		(permissionMode) => {
			const { onPermissionModeChange } = renderSheet({
				agentId: 'grok',
				permissionMode,
				hasReadOnlyCapability: false,
				hasStandardCapability: AGENT_CAPABILITIES.grok.supportsStandardPermissionMode ?? false,
			});

			expect(screen.queryByTestId('composer-options-access')).not.toBeInTheDocument();
			expect(
				screen.queryByRole('button', { name: /Full Access|Read-Only|Standard|ACP|Plan/i })
			).not.toBeInTheDocument();
			fireEvent.click(screen.getByTestId('composer-options-history'));
			expect(onPermissionModeChange).not.toHaveBeenCalled();
		}
	);

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

	it('draws the surface rows after the built-in sections', () => {
		renderSheet({ extraRows: <div data-testid="extra-row">Extra</div> });

		const extra = screen.getByTestId('extra-row');
		const model = screen.getByTestId('composer-options-model');
		expect(model.compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
