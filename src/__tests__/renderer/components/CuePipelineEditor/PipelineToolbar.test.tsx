import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { mockTheme } from '../../../helpers/mockTheme';
import {
	PipelineToolbar,
	PipelineToolbarProps,
} from '../../../../renderer/components/CuePipelineEditor/PipelineToolbar';

const selectorProps = vi.fn();
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineSelector', () => ({
	PipelineSelector: (props: any) => {
		selectorProps(props);
		return <div data-testid="pipeline-selector" />;
	},
}));

const scope = { sessionId: 'sess-1', sessionName: 'Marketing', pipelineIds: ['p1', 'p2'] };

function buildProps(overrides: Partial<PipelineToolbarProps> = {}): PipelineToolbarProps {
	return {
		theme: mockTheme,
		isAllPipelinesView: false,
		triggerDrawerOpen: false,
		setTriggerDrawerOpen: vi.fn(),
		agentDrawerOpen: false,
		setAgentDrawerOpen: vi.fn(),
		pipelines: [],
		selectedPipelineId: null,
		selectPipeline: vi.fn(),
		createPipeline: vi.fn(),
		deletePipeline: vi.fn(),
		renamePipeline: vi.fn(),
		changePipelineColor: vi.fn(),
		isDirty: false,
		saveStatus: 'idle',
		handleSave: vi.fn(),
		handleDiscard: vi.fn(),
		validationErrors: [],
		...overrides,
	};
}

describe('PipelineToolbar', () => {
	it('disables the Triggers button when isAllPipelinesView is true', () => {
		const props = buildProps({ isAllPipelinesView: true });
		render(<PipelineToolbar {...props} />);
		const triggersBtn = screen.getByRole('button', { name: /triggers/i });
		expect(triggersBtn).toBeDisabled();
	});

	it('disables the Agents button when isAllPipelinesView is true', () => {
		const props = buildProps({ isAllPipelinesView: true });
		render(<PipelineToolbar {...props} />);
		const agentsBtn = screen.getByRole('button', { name: /agents/i });
		expect(agentsBtn).toBeDisabled();
	});

	it('calls setTriggerDrawerOpen when Triggers button is clicked and not disabled', () => {
		const setTriggerDrawerOpen = vi.fn();
		const props = buildProps({ isAllPipelinesView: false, setTriggerDrawerOpen });
		render(<PipelineToolbar {...props} />);
		fireEvent.click(screen.getByRole('button', { name: /triggers/i }));
		expect(setTriggerDrawerOpen).toHaveBeenCalledTimes(1);
		// It's called with a toggling function
		expect(typeof setTriggerDrawerOpen.mock.calls[0][0]).toBe('function');
	});

	it('calls setAgentDrawerOpen when Agents button is clicked and not disabled', () => {
		const setAgentDrawerOpen = vi.fn();
		const props = buildProps({ isAllPipelinesView: false, setAgentDrawerOpen });
		render(<PipelineToolbar {...props} />);
		fireEvent.click(screen.getByRole('button', { name: /agents/i }));
		expect(setAgentDrawerOpen).toHaveBeenCalledTimes(1);
		expect(typeof setAgentDrawerOpen.mock.calls[0][0]).toBe('function');
	});

	it('does not render a Settings gear button (moved to Settings → Encore Features → Maestro Cue)', () => {
		const props = buildProps();
		render(<PipelineToolbar {...props} />);
		expect(screen.queryByTitle('Global Cue settings')).not.toBeInTheDocument();
	});

	it('renders Discard button when isDirty is true', () => {
		const props = buildProps({ isDirty: true });
		render(<PipelineToolbar {...props} />);
		expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
	});

	it('does not render Discard button when isDirty is false', () => {
		const props = buildProps({ isDirty: false });
		render(<PipelineToolbar {...props} />);
		expect(screen.queryByRole('button', { name: /discard/i })).not.toBeInTheDocument();
	});

	it('shows "Save" text when saveStatus is idle', () => {
		const props = buildProps({ saveStatus: 'idle' });
		render(<PipelineToolbar {...props} />);
		const saveBtn = screen.getByRole('button', { name: /save/i });
		expect(saveBtn.textContent).toContain('Save');
		expect(saveBtn.textContent).not.toContain('Saving');
		expect(saveBtn.textContent).not.toContain('Saved');
	});

	it('shows "Saving..." text when saveStatus is saving', () => {
		const props = buildProps({ saveStatus: 'saving' });
		render(<PipelineToolbar {...props} />);
		expect(screen.getByText('Saving...')).toBeInTheDocument();
	});

	it('shows "Saved" text when saveStatus is success', () => {
		const props = buildProps({ saveStatus: 'success' });
		render(<PipelineToolbar {...props} />);
		expect(screen.getByText('Saved')).toBeInTheDocument();
	});

	it('shows dirty indicator dot when isDirty is true and saveStatus is idle', () => {
		const props = buildProps({ isDirty: true, saveStatus: 'idle' });
		render(<PipelineToolbar {...props} />);
		expect(screen.getByTestId('dirty-indicator')).toBeInTheDocument();
	});

	it('does not show dirty indicator dot when isDirty is false', () => {
		const props = buildProps({ isDirty: false, saveStatus: 'idle' });
		render(<PipelineToolbar {...props} />);
		expect(screen.queryByTestId('dirty-indicator')).not.toBeInTheDocument();
	});

	it('shows validation errors bar when validationErrors is non-empty', () => {
		const props = buildProps({ validationErrors: ['Missing trigger', 'No agents'] });
		render(<PipelineToolbar {...props} />);
		expect(screen.getByText(/Missing trigger/)).toBeInTheDocument();
		expect(screen.getByText(/No agents/)).toBeInTheDocument();
	});

	it('does not show validation errors bar when validationErrors is empty', () => {
		const props = buildProps({ validationErrors: [] });
		render(<PipelineToolbar {...props} />);
		expect(screen.queryByText(/Missing trigger/)).not.toBeInTheDocument();
	});

	describe('agent scope', () => {
		it('hands the selector the agents and the active one', () => {
			const onSelectAgentScope = vi.fn();
			render(
				<PipelineToolbar
					{...buildProps({
						agentScopes: [scope],
						activeScope: scope,
						onSelectAgentScope,
					})}
				/>
			);
			const props = selectorProps.mock.calls[selectorProps.mock.calls.length - 1][0];
			expect(props.agents).toEqual([scope]);
			expect(props.activeAgent).toBe(scope);
			expect(props.onSelectAgent).toBe(onSelectAgentScope);
		});

		it('offers a clear button only while a scope is active', () => {
			const onClearScope = vi.fn();
			const { rerender } = render(<PipelineToolbar {...buildProps({ onClearScope })} />);
			expect(screen.queryByTestId('pipeline-scope-clear')).not.toBeInTheDocument();

			rerender(<PipelineToolbar {...buildProps({ onClearScope, activeScope: scope })} />);
			fireEvent.click(screen.getByLabelText('Show all pipelines'));
			expect(onClearScope).toHaveBeenCalledTimes(1);
		});

		it('leads back to the scope a pipeline was opened from', () => {
			const onReturnToScope = vi.fn();
			render(
				<PipelineToolbar
					{...buildProps({ selectedPipelineId: 'p1', parentScope: scope, onReturnToScope })}
				/>
			);
			const back = screen.getByTestId('pipeline-scope-back');
			expect(back).toHaveTextContent('Marketing');
			fireEvent.click(back);
			expect(onReturnToScope).toHaveBeenCalledTimes(1);
		});

		it('shows no breadcrumb without a parent scope', () => {
			render(<PipelineToolbar {...buildProps({ onReturnToScope: vi.fn() })} />);
			expect(screen.queryByTestId('pipeline-scope-back')).not.toBeInTheDocument();
		});
	});
});
