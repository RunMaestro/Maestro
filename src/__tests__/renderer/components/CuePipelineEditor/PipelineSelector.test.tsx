import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PipelineSelector } from '../../../../renderer/components/CuePipelineEditor/PipelineSelector';
import { PIPELINE_COLORS, type CuePipeline } from '../../../../shared/cue-pipeline-types';

const mockPipelines: CuePipeline[] = [
	{
		id: 'p1',
		name: 'Deploy Pipeline',
		color: '#06b6d4',
		nodes: [],
		edges: [],
	},
	{
		id: 'p2',
		name: 'Review Pipeline',
		color: '#8b5cf6',
		nodes: [],
		edges: [],
	},
];

const defaultProps = {
	pipelines: mockPipelines,
	selectedPipelineId: null as string | null,
	onSelect: vi.fn(),
	onCreatePipeline: vi.fn(),
	onDeletePipeline: vi.fn(),
	onRenamePipeline: vi.fn(),
	onChangePipelineColor: vi.fn(),
};

describe('PipelineSelector', () => {
	it('should show "All Pipelines" when no pipeline is selected', () => {
		render(<PipelineSelector {...defaultProps} />);
		expect(screen.getByText('All Pipelines')).toBeInTheDocument();
	});

	it('should show selected pipeline name', () => {
		render(<PipelineSelector {...defaultProps} selectedPipelineId="p1" />);
		expect(screen.getByText('Deploy Pipeline')).toBeInTheDocument();
	});

	it('should open dropdown on click and list all pipelines', () => {
		render(<PipelineSelector {...defaultProps} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));

		// Dropdown shows All Pipelines option + each pipeline
		expect(screen.getByText('Deploy Pipeline')).toBeInTheDocument();
		expect(screen.getByText('Review Pipeline')).toBeInTheDocument();
		expect(screen.getByText('New Pipeline')).toBeInTheDocument();
	});

	it('should call onSelect when a pipeline is clicked', () => {
		const onSelect = vi.fn();
		render(<PipelineSelector {...defaultProps} onSelect={onSelect} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));
		fireEvent.click(screen.getByText('Deploy Pipeline'));

		expect(onSelect).toHaveBeenCalledWith('p1');
	});

	it('should call onCreatePipeline when New Pipeline is clicked', () => {
		const onCreatePipeline = vi.fn();
		render(<PipelineSelector {...defaultProps} onCreatePipeline={onCreatePipeline} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));
		fireEvent.click(screen.getByText('New Pipeline'));

		expect(onCreatePipeline).toHaveBeenCalled();
	});

	it('should enter rename mode on double-click', () => {
		render(<PipelineSelector {...defaultProps} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));

		const pipelineItem = screen.getByText('Deploy Pipeline').closest('div[class]')!;
		fireEvent.doubleClick(pipelineItem);

		const input = screen.getByDisplayValue('Deploy Pipeline');
		expect(input).toBeInTheDocument();
	});

	it('should call onRenamePipeline on Enter in rename mode', () => {
		const onRenamePipeline = vi.fn();
		render(<PipelineSelector {...defaultProps} onRenamePipeline={onRenamePipeline} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));

		const pipelineItem = screen.getByText('Deploy Pipeline').closest('div[class]')!;
		fireEvent.doubleClick(pipelineItem);

		const input = screen.getByDisplayValue('Deploy Pipeline');
		fireEvent.change(input, { target: { value: 'Renamed Pipeline' } });
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onRenamePipeline).toHaveBeenCalledWith('p1', 'Renamed Pipeline');
	});

	it('should cancel rename on Escape', () => {
		const onRenamePipeline = vi.fn();
		render(<PipelineSelector {...defaultProps} onRenamePipeline={onRenamePipeline} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));

		const pipelineItem = screen.getByText('Deploy Pipeline').closest('div[class]')!;
		fireEvent.doubleClick(pipelineItem);

		const input = screen.getByDisplayValue('Deploy Pipeline');
		fireEvent.keyDown(input, { key: 'Escape' });

		expect(onRenamePipeline).not.toHaveBeenCalled();
		// Should be back to showing text, not input
		expect(screen.getByText('Deploy Pipeline')).toBeInTheDocument();
	});

	it('should enter rename mode when pencil icon is clicked', () => {
		const onRenamePipeline = vi.fn();
		render(<PipelineSelector {...defaultProps} onRenamePipeline={onRenamePipeline} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));

		const pencilButtons = screen.getAllByTitle('Rename pipeline');
		expect(pencilButtons.length).toBeGreaterThan(0);

		fireEvent.click(pencilButtons[0]);

		const input = screen.getByDisplayValue('Deploy Pipeline');
		expect(input).toBeInTheDocument();
	});

	it('should show color picker when color dot is clicked', () => {
		const onChangePipelineColor = vi.fn();
		render(<PipelineSelector {...defaultProps} onChangePipelineColor={onChangePipelineColor} />);

		fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));

		// Click the first color dot (has title "Change color")
		const colorDots = screen.getAllByTitle('Change color');
		expect(colorDots.length).toBeGreaterThan(0);
		fireEvent.click(colorDots[0]);

		// Color palette should appear with 12 swatches
		const swatches = screen.getAllByTitle(/^#/);
		expect(swatches.length).toBe(12);

		// Click a swatch at index 2 in the canonical PIPELINE_COLORS palette.
		// Referencing the shared constant (instead of the literal '#f59e0b')
		// keeps this test in sync if the palette order ever changes — only
		// pipelineColorPalette.test.ts owns the literal-value snapshot.
		fireEvent.click(swatches[2]);
		expect(onChangePipelineColor).toHaveBeenCalledWith('p1', PIPELINE_COLORS[2]);
	});

	it('should apply custom textColor and borderColor', () => {
		const { container } = render(
			<PipelineSelector {...defaultProps} textColor="#ff0000" borderColor="#00ff00" />
		);

		const button = container.querySelector('button')!;
		// JSDOM normalizes hex to rgb
		expect(button.style.color).toBe('rgb(255, 0, 0)');
		expect(button.style.border).toContain('rgb(0, 255, 0)');
	});

	it('should use default colors when textColor and borderColor are not provided', () => {
		const { container } = render(<PipelineSelector {...defaultProps} />);

		const button = container.querySelector('button')!;
		// Browser normalizes rgba spacing
		expect(button.style.color).toContain('rgba');
		expect(button.style.color).toContain('0.9');
		expect(button.style.border).toContain('rgba');
		expect(button.style.border).toContain('0.12');
	});
});
