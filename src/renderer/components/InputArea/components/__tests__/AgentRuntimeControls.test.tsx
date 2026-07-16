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
			{ id: 'low', label: 'Low' },
			{ id: 'medium', label: 'Medium' },
		],
	},
	{
		id: 'auto-retry',
		label: 'Auto retry',
		kind: 'toggle' as const,
		value: true,
	},
	{
		id: 'compact',
		label: 'Compact',
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

describe('AgentRuntimeControls', () => {
	it('renders OMP controls except model controls', () => {
		render(
			<AgentRuntimeControls
				sessionId="session-1"
				controls={controls}
				theme={THEMES.dracula}
				onSetControl={vi.fn()}
			/>
		);

		expect(screen.getByLabelText('Thinking level')).toHaveValue('medium');
		expect(screen.getByRole('button', { name: 'Auto retry' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.queryByLabelText('Model')).not.toBeInTheDocument();
		expect(screen.getByTestId('native-runtime-toolbar-row')).toHaveClass('w-full', 'flex-wrap');
	});

	it('dispatches selected values and toggles for the active session', () => {
		const onSetControl = vi.fn();
		render(
			<AgentRuntimeControls
				sessionId="session-1"
				controls={controls}
				theme={THEMES.dracula}
				onSetControl={onSetControl}
			/>
		);

		fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'low' } });
		fireEvent.click(screen.getByRole('button', { name: 'Auto retry' }));
		fireEvent.click(screen.getByRole('button', { name: 'Compact' }));

		expect(onSetControl).toHaveBeenNthCalledWith(1, 'session-1', 'thinking-level', 'low');
		expect(onSetControl).toHaveBeenNthCalledWith(2, 'session-1', 'auto-retry', false);
		expect(onSetControl).toHaveBeenNthCalledWith(3, 'session-1', 'compact', true);
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
