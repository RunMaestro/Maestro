import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	PipelineSelector,
	pipelineMenuDefaultSize,
} from '../../../../renderer/components/CuePipelineEditor/PipelineSelector';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
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
	beforeEach(() => {
		useSettingsStore.setState({ modalSizes: {} });
	});

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
		// keeps this test in sync if the palette order ever changes - only
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
	describe('resizable menu', () => {
		// Ending a drag installs a one-shot capture-phase click suppressor (so
		// releasing the mouse outside the menu doesn't read as a click-away) that
		// is torn down on the next macrotask. Let that run, or it swallows the
		// trigger click of whichever test comes next.
		afterEach(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		function openMenu(pipelines: CuePipeline[] = mockPipelines) {
			render(<PipelineSelector {...defaultProps} pipelines={pipelines} />);
			fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));
			return screen.getByTestId('pipeline-selector-menu');
		}

		it('opens tall enough for ten pipelines plus the two fixed rows', () => {
			// 11 rows of 32 (ten pipelines + All Pipelines), two 1px rules, and the
			// 32px New Pipeline footer.
			expect(openMenu()).toHaveStyle({ height: '386px' });
		});

		it('opens at the floor width when every name is short', () => {
			expect(openMenu()).toHaveStyle({ width: '220px' });
		});

		it('opens wide enough for the longest pipeline name', () => {
			const longName = 'Nightly Dependency Audit And Report';
			const menu = openMenu([...mockPipelines, { ...mockPipelines[0], id: 'p3', name: longName }]);

			expect(menu.style.width).toBe(`${pipelineMenuDefaultSize([longName]).width}px`);
			expect(parseInt(menu.style.width, 10)).toBeGreaterThan(220);
		});

		it('tracks the cursor 1:1 while dragging and remembers the size', () => {
			const menu = openMenu();

			fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'), { clientX: 0, clientY: 0 });
			fireEvent.mouseMove(document, { clientX: 60, clientY: 40 });

			// Anchored at its top-left, so the menu grows by exactly the drag delta.
			expect(menu.style.width).toBe('280px');
			expect(menu.style.height).toBe('426px');

			fireEvent.mouseUp(document);

			expect(useSettingsStore.getState().modalSizes['cue-pipeline-selector']).toEqual({
				width: 280,
				height: 426,
			});
		});

		it('restores a remembered size on the next open', () => {
			useSettingsStore.setState({
				modalSizes: { 'cue-pipeline-selector': { width: 300, height: 400 } },
			});

			expect(openMenu()).toHaveStyle({ width: '300px', height: '400px' });
		});

		it('clamps a drag to the minimum size', () => {
			const menu = openMenu();

			fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'), { clientX: 0, clientY: 0 });
			fireEvent.mouseMove(document, { clientX: -500, clientY: -500 });
			fireEvent.mouseUp(document);

			expect(menu.style.width).toBe('180px');
			expect(menu.style.height).toBe('140px');
		});

		it('forgets the remembered size on double-click of the grip', () => {
			useSettingsStore.setState({
				modalSizes: { 'cue-pipeline-selector': { width: 300, height: 400 } },
			});
			const menu = openMenu();

			fireEvent.doubleClick(screen.getByTestId('modal-resize-grip'));

			expect(useSettingsStore.getState().modalSizes['cue-pipeline-selector']).toBeUndefined();
			expect(menu).toHaveStyle({ width: '220px', height: '386px' });
		});
	});
	describe('pipelineMenuDefaultSize', () => {
		it('always leaves room for the All Pipelines row itself', () => {
			expect(pipelineMenuDefaultSize([]).width).toBe(220);
		});

		it('grows with the longest name, not the number of names', () => {
			const one = pipelineMenuDefaultSize(['Nightly Dependency Audit And Report']);
			const many = pipelineMenuDefaultSize(['a', 'b', 'Nightly Dependency Audit And Report', 'c']);

			expect(many).toEqual(one);
		});

		it('caps the width so one pathological name cannot size the menu to the screen', () => {
			expect(pipelineMenuDefaultSize(['x'.repeat(500)]).width).toBe(460);
		});

		it('is the same height regardless of how many pipelines exist', () => {
			expect(pipelineMenuDefaultSize([]).height).toBe(pipelineMenuDefaultSize(['a', 'b']).height);
		});
	});
});
