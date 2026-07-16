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

describe('AgentRuntimeControls', () => {
	it('renders two compact pills instead of a full-width toolbar row', () => {
		renderControls();

		const container = screen.getByTestId('omp-runtime-controls');
		expect(container).not.toHaveClass('w-full');
		expect(container).not.toHaveClass('flex-wrap');

		// Only the two pill triggers are visible before opening a menu.
		expect(screen.getByRole('button', { name: /medium/ })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		expect(screen.getByRole('button', { name: 'OMP runtime settings' })).toHaveAttribute(
			'aria-expanded',
			'false'
		);
		expect(screen.queryByLabelText('Steering mode')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Compact' })).not.toBeInTheDocument();
	});

	it('never renders a model control (owned by the ordinary model pill)', () => {
		renderControls();
		fireEvent.click(screen.getByRole('button', { name: 'OMP runtime settings' }));
		expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
	});

	it('changes thinking level through the thinking pill menu', () => {
		const onSetControl = renderControls();

		const pill = screen.getByRole('button', { name: /medium/ });
		fireEvent.click(pill);
		expect(pill).toHaveAttribute('aria-expanded', 'true');

		const highOption = screen.getByRole('menuitemradio', { name: 'high' });
		expect(screen.getByRole('menuitemradio', { name: 'medium' })).toHaveAttribute(
			'aria-checked',
			'true'
		);
		fireEvent.click(highOption);

		expect(onSetControl).toHaveBeenCalledWith('session-1', 'thinking-level', 'high');
		// Menu closes after choosing.
		expect(screen.queryByRole('menuitemradio', { name: 'high' })).not.toBeInTheDocument();
	});

	it('groups delivery, automation, session, and interrupt controls in the runtime menu', () => {
		renderControls();
		fireEvent.click(screen.getByRole('button', { name: 'OMP runtime settings' }));

		const menu = screen.getByLabelText('Native runtime controls');
		expect(menu).toHaveTextContent('Delivery');
		expect(menu).toHaveTextContent('Automation');
		expect(menu).toHaveTextContent('Session');

		// Interrupt actions live in their own separated group.
		const interruptGroup = screen.getByRole('group', { name: 'Interrupt actions' });
		expect(interruptGroup).toHaveTextContent('Abort shell command');
		expect(menu).toHaveTextContent('Compact');
	});

	it('dispatches select, toggle, and action values for the active session', () => {
		const onSetControl = renderControls();
		fireEvent.click(screen.getByRole('button', { name: 'OMP runtime settings' }));

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
		// One-shot actions close the menu.
		expect(screen.queryByLabelText('Native runtime controls')).not.toBeInTheDocument();
	});

	it('dispatches interrupt actions and closes the menu', () => {
		const onSetControl = renderControls();
		fireEvent.click(screen.getByRole('button', { name: 'OMP runtime settings' }));
		fireEvent.click(screen.getByRole('button', { name: 'Abort shell command' }));

		expect(onSetControl).toHaveBeenCalledWith('session-1', 'abort-bash', true);
		expect(screen.queryByRole('group', { name: 'Interrupt actions' })).not.toBeInTheDocument();
	});

	it('closes the runtime menu on Escape', () => {
		renderControls();
		fireEvent.click(screen.getByRole('button', { name: 'OMP runtime settings' }));
		const menu = screen.getByLabelText('Native runtime controls');
		fireEvent.keyDown(menu, { key: 'Escape' });
		expect(screen.queryByLabelText('Native runtime controls')).not.toBeInTheDocument();
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
