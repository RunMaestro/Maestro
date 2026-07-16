import '@testing-library/jest-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { THEMES } from '../../../../constants/themes';
import { AgentRuntimeControls } from '../AgentRuntimeControls';

const controls = [
	{
		id: 'thinking-level',
		label: 'Thinking level',
		kind: 'select' as const,
		value: 'medium',
		options: [
			{ id: 'low', label: 'low' },
			{ id: 'medium', label: 'medium' },
			{ id: 'high', label: 'high' },
		],
	},
	{
		id: 'steering-mode',
		label: 'Steering mode',
		kind: 'select' as const,
		value: 'all',
		options: [
			{ id: 'all', label: 'All' },
			{ id: 'one-at-a-time', label: 'One at a time' },
		],
	},
	{
		id: 'auto-retry',
		label: 'Auto-retry',
		kind: 'toggle' as const,
		value: true,
	},
	{
		id: 'compact',
		label: 'Compact',
		kind: 'action' as const,
	},
	{
		id: 'abort-bash',
		label: 'Abort shell command',
		kind: 'action' as const,
	},
	{
		id: 'model',
		label: 'Model',
		kind: 'select' as const,
		value: 'ignored',
		options: [{ id: 'ignored', label: 'Ignored' }],
	},
];

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function renderControls(onSetControl = vi.fn()) {
	render(
		<AgentRuntimeControls
			sessionId="session-1"
			controls={controls}
			theme={THEMES.dracula}
			onSetControl={onSetControl}
		/>
	);
	return onSetControl;
}

function thinkingTrigger(): HTMLElement {
	return screen.getByRole('button', { name: /medium/ });
}

function runtimeTrigger(): HTMLElement {
	return screen.getByRole('button', { name: 'OMP runtime settings' });
}

describe('AgentRuntimeControls', () => {
	it('renders two compact pills instead of a full-width toolbar row', () => {
		renderControls();

		const container = screen.getByTestId('omp-runtime-controls');
		expect(container).not.toHaveClass('w-full');
		expect(container).not.toHaveClass('flex-wrap');

		// Only the two pill triggers are visible before opening a popup.
		expect(thinkingTrigger()).toHaveAttribute('aria-expanded', 'false');
		expect(thinkingTrigger()).toHaveAttribute('aria-haspopup', 'menu');
		expect(runtimeTrigger()).toHaveAttribute('aria-expanded', 'false');
		expect(runtimeTrigger()).toHaveAttribute('aria-haspopup', 'dialog');
		expect(screen.queryByLabelText('Steering mode')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Compact' })).not.toBeInTheDocument();
	});

	it('never renders a model control (owned by the ordinary model pill)', () => {
		renderControls();
		fireEvent.click(runtimeTrigger());
		expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
	});

	describe('thinking pill menu', () => {
		it('opens as a menu and moves focus to the selected level', () => {
			renderControls();

			fireEvent.click(thinkingTrigger());

			const menu = screen.getByRole('menu', { name: 'Thinking level' });
			expect(menu).toBeInTheDocument();
			expect(thinkingTrigger()).toHaveAttribute('aria-expanded', 'true');
			// Focus lands on the currently selected level, not just the first item.
			const selected = screen.getByRole('menuitemradio', { name: 'medium' });
			expect(selected).toHaveAttribute('aria-checked', 'true');
			expect(document.activeElement).toBe(selected);
		});

		it('supports full keyboard flow: ArrowDown opens, arrows rove, Escape restores the trigger', () => {
			renderControls();
			const trigger = thinkingTrigger();
			trigger.focus();

			// ArrowDown on the closed trigger opens the menu and focuses "medium".
			fireEvent.keyDown(trigger, { key: 'ArrowDown' });
			expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'medium' }));

			// Arrow keys rove between items (with wrap-around).
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
			expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'high' }));
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
			expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'low' }));
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
			expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'high' }));
			fireEvent.keyDown(document.activeElement!, { key: 'Home' });
			expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'low' }));
			fireEvent.keyDown(document.activeElement!, { key: 'End' });
			expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'high' }));

			// Escape inside the menu closes it and restores focus to the trigger.
			fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
			expect(screen.queryByRole('menu', { name: 'Thinking level' })).not.toBeInTheDocument();
			expect(document.activeElement).toBe(trigger);
			expect(trigger).toHaveAttribute('aria-expanded', 'false');
		});

		it('activating a level dispatches it, closes the menu, and restores trigger focus', () => {
			const onSetControl = renderControls();
			const trigger = thinkingTrigger();
			trigger.focus();
			fireEvent.keyDown(trigger, { key: 'ArrowDown' });

			// Move to "high" and activate it (keyboard activation of a focused
			// button is a click at the DOM level).
			fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
			fireEvent.click(document.activeElement!);

			expect(onSetControl).toHaveBeenCalledWith('session-1', 'thinking-level', 'high');
			expect(screen.queryByRole('menu', { name: 'Thinking level' })).not.toBeInTheDocument();
			expect(document.activeElement).toBe(trigger);
		});

		it('closes from the trigger with Escape while the menu is open', () => {
			renderControls();
			fireEvent.click(thinkingTrigger());
			const trigger = thinkingTrigger();
			trigger.focus();

			fireEvent.keyDown(trigger, { key: 'Escape' });
			expect(screen.queryByRole('menu', { name: 'Thinking level' })).not.toBeInTheDocument();
			expect(document.activeElement).toBe(trigger);
		});
	});

	describe('runtime settings popover', () => {
		it('opens as a labelled dialog and moves focus to the first control', () => {
			renderControls();

			fireEvent.click(runtimeTrigger());

			const dialog = screen.getByRole('dialog', { name: 'Native runtime controls' });
			expect(dialog).toBeInTheDocument();
			expect(runtimeTrigger()).toHaveAttribute('aria-expanded', 'true');
			expect(document.activeElement).toBe(screen.getByLabelText('Steering mode'));
		});

		it('groups delivery, automation, session, and interrupt controls', () => {
			renderControls();
			fireEvent.click(runtimeTrigger());

			const dialog = screen.getByRole('dialog', { name: 'Native runtime controls' });
			expect(dialog).toHaveTextContent('Delivery');
			expect(dialog).toHaveTextContent('Automation');
			expect(dialog).toHaveTextContent('Session');

			// Interrupt actions live in their own separated group.
			const interruptGroup = screen.getByRole('group', { name: 'Interrupt actions' });
			expect(interruptGroup).toHaveTextContent('Abort shell command');
			expect(dialog).toHaveTextContent('Compact');
		});

		it('dispatches select, toggle, and action values for the active session', () => {
			const onSetControl = renderControls();
			fireEvent.click(runtimeTrigger());

			fireEvent.change(screen.getByLabelText('Steering mode'), {
				target: { value: 'one-at-a-time' },
			});
			expect(onSetControl).toHaveBeenCalledWith('session-1', 'steering-mode', 'one-at-a-time');

			const autoRetry = screen.getByRole('switch', { name: /Auto-retry/ });
			expect(autoRetry).toHaveAttribute('aria-checked', 'true');
			fireEvent.click(autoRetry);
			expect(onSetControl).toHaveBeenCalledWith('session-1', 'auto-retry', false);

			fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
			expect(onSetControl).toHaveBeenCalledWith('session-1', 'compact', true);
			// One-shot actions close the popover and hand focus back to the trigger.
			expect(
				screen.queryByRole('dialog', { name: 'Native runtime controls' })
			).not.toBeInTheDocument();
			expect(document.activeElement).toBe(runtimeTrigger());
		});

		it('dispatches interrupt actions and closes the popover', () => {
			const onSetControl = renderControls();
			fireEvent.click(runtimeTrigger());
			fireEvent.click(screen.getByRole('button', { name: 'Abort shell command' }));

			expect(onSetControl).toHaveBeenCalledWith('session-1', 'abort-bash', true);
			expect(screen.queryByRole('group', { name: 'Interrupt actions' })).not.toBeInTheDocument();
		});

		it('closes on Escape from inside and restores focus to the trigger', () => {
			renderControls();
			fireEvent.click(runtimeTrigger());

			// Escape pressed on the focused control inside the popup.
			fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
			expect(
				screen.queryByRole('dialog', { name: 'Native runtime controls' })
			).not.toBeInTheDocument();
			expect(document.activeElement).toBe(runtimeTrigger());
			expect(runtimeTrigger()).toHaveAttribute('aria-expanded', 'false');
		});

		it('closes from the trigger with Escape while open', () => {
			renderControls();
			fireEvent.click(runtimeTrigger());
			const trigger = runtimeTrigger();
			trigger.focus();

			fireEvent.keyDown(trigger, { key: 'Escape' });
			expect(
				screen.queryByRole('dialog', { name: 'Native runtime controls' })
			).not.toBeInTheDocument();
			expect(document.activeElement).toBe(trigger);
		});
	});

	it('renders nothing when no native runtime controls are available', () => {
		const { container } = render(
			<AgentRuntimeControls
				sessionId="session-1"
				controls={[]}
				theme={THEMES.dracula}
				onSetControl={vi.fn()}
			/>
		);

		expect(container).toBeEmptyDOMElement();
	});
});
