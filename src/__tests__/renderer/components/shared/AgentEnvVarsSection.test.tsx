/**
 * @fileoverview Tests for AgentEnvVarsSection, the per-agent env var editor
 * extracted from AgentConfigPanel so a tabbed agent form can mount it on its
 * own Environment tab.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	AgentEnvVarsSection,
	type AgentEnvVarsSectionProps,
} from '../../../../renderer/components/shared/AgentEnvVarsSection';
import { createMockTheme } from '../../../helpers/mockTheme';

function createProps(overrides: Partial<AgentEnvVarsSectionProps> = {}): AgentEnvVarsSectionProps {
	return {
		theme: createMockTheme(),
		toolType: 'claude-code',
		customEnvVars: {},
		onEnvVarKeyChange: vi.fn(),
		onEnvVarValueChange: vi.fn(),
		onEnvVarRemove: vi.fn(),
		onEnvVarAdd: vi.fn(),
		onEnvVarsBlur: vi.fn(),
		...overrides,
	};
}

describe('AgentEnvVarsSection', () => {
	it('asks the parent to add a row and focuses the unnamed row it adds', () => {
		const onEnvVarAdd = vi.fn();
		const { rerender } = render(<AgentEnvVarsSection {...createProps({ onEnvVarAdd })} />);

		fireEvent.click(screen.getByText('Add Variable'));
		expect(onEnvVarAdd).toHaveBeenCalledTimes(1);

		// The parent owns the record: simulate it inserting the blank row.
		rerender(<AgentEnvVarsSection {...createProps({ onEnvVarAdd, customEnvVars: { '': '' } })} />);
		expect(screen.getByTestId('env-var-key-input')).toHaveFocus();
	});

	it('defers a key rename to blur, then reports it and the blur', () => {
		const onEnvVarKeyChange = vi.fn();
		const onEnvVarsBlur = vi.fn();
		render(
			<AgentEnvVarsSection
				{...createProps({ customEnvVars: { OLD: 'v' }, onEnvVarKeyChange, onEnvVarsBlur })}
			/>
		);

		const keyInput = screen.getByDisplayValue('OLD');
		fireEvent.change(keyInput, { target: { value: 'NEW' } });
		expect(onEnvVarKeyChange).not.toHaveBeenCalled();

		fireEvent.blur(keyInput);
		expect(onEnvVarKeyChange).toHaveBeenCalledWith('OLD', 'NEW', 'v', true);
		expect(onEnvVarsBlur).toHaveBeenCalled();
	});

	it('reports a value edit on a live row immediately', () => {
		const onEnvVarValueChange = vi.fn();
		render(
			<AgentEnvVarsSection {...createProps({ customEnvVars: { KEY: 'a' }, onEnvVarValueChange })} />
		);

		fireEvent.change(screen.getByDisplayValue('a'), { target: { value: 'b' } });
		expect(onEnvVarValueChange).toHaveBeenCalledWith('KEY', 'b', true);
	});

	it('parks a live row', () => {
		const onEnvVarToggle = vi.fn();
		render(
			<AgentEnvVarsSection
				{...createProps({
					customEnvVars: { LIVE: 'a' },
					customEnvVarsDisabled: {},
					onEnvVarToggle,
				})}
			/>
		);

		fireEvent.click(screen.getByTitle(/^Disable LIVE/));
		expect(onEnvVarToggle).toHaveBeenCalledWith('LIVE', false);
	});

	it('unparks a parked row', () => {
		const onEnvVarToggle = vi.fn();
		render(
			<AgentEnvVarsSection
				{...createProps({
					customEnvVars: {},
					customEnvVarsDisabled: { PARKED: 'b' },
					onEnvVarToggle,
				})}
			/>
		);

		expect(screen.getByDisplayValue('PARKED')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle(/^Enable PARKED/));
		expect(onEnvVarToggle).toHaveBeenCalledWith('PARKED', true);
	});

	it('draws no eye when the parked record is not supplied', () => {
		render(<AgentEnvVarsSection {...createProps({ customEnvVars: { LIVE: 'a' } })} />);

		expect(screen.queryByTitle(/^Disable /)).not.toBeInTheDocument();
	});

	it('removes a row from the record it lives in', () => {
		const onEnvVarRemove = vi.fn();
		render(
			<AgentEnvVarsSection
				{...createProps({
					customEnvVars: {},
					customEnvVarsDisabled: { PARKED: 'b' },
					onEnvVarToggle: vi.fn(),
					onEnvVarRemove,
				})}
			/>
		);

		fireEvent.click(screen.getByTitle('Remove variable'));
		expect(onEnvVarRemove).toHaveBeenCalledWith('PARKED', false);
	});

	it('shows the built-in list only when asked', () => {
		const { rerender } = render(<AgentEnvVarsSection {...createProps()} />);
		expect(screen.queryByText('MAESTRO_SESSION_RESUMED')).not.toBeInTheDocument();

		rerender(<AgentEnvVarsSection {...createProps({ showBuiltInEnvVars: true })} />);
		expect(screen.getByText('MAESTRO_SESSION_RESUMED')).toBeInTheDocument();
		expect(screen.getByText('1 (when resuming)')).toBeInTheDocument();
	});

	it('keeps the built-in variable tooltip distinct from the form surface', () => {
		const theme = createMockTheme({ colors: { surfaceElevated: '#312449' } });
		render(<AgentEnvVarsSection {...createProps({ theme, showBuiltInEnvVars: true })} />);
		fireEvent.click(screen.getByTitle('What is this?'));
		expect(screen.getByText(/Set to "1" when resuming/)).toHaveStyle({
			backgroundColor: '#312449',
		});
	});
});
