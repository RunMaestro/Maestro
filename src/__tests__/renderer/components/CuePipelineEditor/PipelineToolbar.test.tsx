import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { mockTheme } from '../../../helpers/mockTheme';
import {
	PipelineToolbar,
	PipelineToolbarProps,
} from '../../../../renderer/components/CuePipelineEditor/PipelineToolbar';

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineSelector', () => ({
	PipelineSelector: (props: any) => <div data-testid="pipeline-selector" />,
}));

function buildProps(overrides: Partial<PipelineToolbarProps> = {}): PipelineToolbarProps {
	return {
		theme: mockTheme,
		isAllPipelinesView: false,
		triggerDrawerOpen: false,
		setTriggerDrawerOpen: vi.fn(),
		agentDrawerOpen: false,
		setAgentDrawerOpen: vi.fn(),
		showSettings: false,
		setShowSettings: vi.fn(),
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

	it('calls setShowSettings when Settings button is clicked', () => {
		const setShowSettings = vi.fn();
		const props = buildProps({ setShowSettings });
		render(<PipelineToolbar {...props} />);
		const settingsBtn = screen.getByTitle('Global Cue settings');
		fireEvent.click(settingsBtn);
		expect(setShowSettings).toHaveBeenCalledTimes(1);
		expect(typeof setShowSettings.mock.calls[0][0]).toBe('function');
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
});
