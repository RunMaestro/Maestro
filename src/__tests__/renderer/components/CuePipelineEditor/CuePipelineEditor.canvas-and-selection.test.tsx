// Source: src/__tests__/renderer/components/CuePipelineEditor/CuePipelineEditor.drag.test.tsx
// Source: src/__tests__/renderer/components/CuePipelineEditor/PipelineSelector.test.tsx
// Source: src/__tests__/renderer/components/CuePipelineEditor/CuePipelineEditor.initialViewport.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { CuePipelineEditor } from '../../../../renderer/components/CuePipelineEditor/CuePipelineEditor';
import { mockTheme } from '../../../helpers/mockTheme';
import { afterEach } from 'vitest';
import { render as rtlRender } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { PipelineSelector } from '../../../../renderer/components/CuePipelineEditor/PipelineSelector';
import { pipelineMenuDefaultSize } from '../../../../renderer/components/CuePipelineEditor/PipelineSelector';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { PIPELINE_COLORS } from '../../../../shared/cue-pipeline-types';
import type { CuePipeline } from '../../../../shared/cue-pipeline-types';

let viewportFixture:
	| {
			fitView: ReturnType<typeof vi.fn>;
			setViewport: ReturnType<typeof vi.fn>;
			nodesInitialized: () => boolean;
			state: () => unknown;
			selection: () => unknown;
			graphNodes: () => unknown[];
	  }
	| undefined;
vi.mock('reactflow', () => {
	return {
		default: (props: any) => <div data-testid="react-flow">{props.children}</div>,
		ReactFlowProvider: ({ children }: any) => <>{children}</>,
		useReactFlow: () => ({
			fitView: viewportFixture?.fitView ?? vi.fn(),
			screenToFlowPosition: vi.fn((pos: any) => pos),
			setViewport: viewportFixture?.setViewport ?? vi.fn(),
		}),
		useNodesInitialized: () => viewportFixture?.nodesInitialized() ?? false,
		// The collision guard subscribes to measured node widths through the store.
		useStore: (selector: any) => selector({ nodeInternals: new Map() }),
		applyNodeChanges: (_changes: any[], nodes: any[]) => nodes,
		Background: () => null,
		Controls: () => null,
		MiniMap: () => null,
		ConnectionMode: { Loose: 'loose' },
		Position: { Left: 'left', Right: 'right' },
		Handle: () => null,
		MarkerType: { ArrowClosed: 'arrowclosed' },
	};
});
let readDragState: () => unknown;
let readDragSelection: () => unknown;
let captureDragCallbacks: (props: { onNodesChange: unknown; onNodeDragStop: unknown }) => void;

vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineCanvas', () => ({
	PipelineCanvas: React.memo((props: any) => {
		if (!viewportFixture) captureDragCallbacks(props);
		return <div data-testid="pipeline-canvas" />;
	}),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineToolbar', () => ({
	PipelineToolbar: () => <div />,
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/PipelineContextMenu', () => ({
	PipelineContextMenu: () => null,
}));
vi.mock('../../../../renderer/hooks/cue/usePipelineState', () => ({
	usePipelineState: () => (viewportFixture ? viewportFixture.state() : readDragState()),
	DEFAULT_TRIGGER_LABELS: {},
	validatePipelines: vi.fn(),
}));
vi.mock('../../../../renderer/hooks/cue/usePipelineSelection', () => ({
	usePipelineSelection: () => (viewportFixture ? viewportFixture.selection() : readDragSelection()),
}));
vi.mock('../../../../renderer/components/CuePipelineEditor/utils/pipelineGraph', () => ({
	convertToReactFlowNodes: vi.fn(() => viewportFixture?.graphNodes() ?? []),
	convertToReactFlowEdges: vi.fn(() => []),
	computePipelineYOffsets: vi.fn(() => new Map()),
	// Footprint constants read at module-eval time by pipelineAutoArrange
	// (imported transitively via CuePipelineEditor). Must be present on the mock
	// or the import throws "No export is defined".
	NODE_BG_WIDTH: 320,
	NODE_BG_HEIGHT: 100,
}));
describeSourceSuite('CuePipelineEditor.drag', () => {
	// Capture props passed to PipelineCanvas
	let capturedOnNodesChange: any = null;
	let capturedOnNodeDragStop: any = null;

	const mockSetPipelineState = vi.fn();
	const mockPersistLayout = vi.fn();

	// IMPORTANT: hooks are called on every render; returning a fresh object literal
	// here makes `pipelineState.pipelines` a new reference each render, which kicks
	// the displayNodes resync effect into an infinite loop and OOMs the worker.
	// Keep the cached object stable across renders (mirrors the other editor tests).
	const stableStateHook = {
		pipelineState: {
			pipelines: [
				{
					id: 'p1',
					name: 'Pipeline 1',
					color: '#06b6d4',
					nodes: [
						{
							id: 'trigger-1',
							type: 'trigger',
							position: { x: 0, y: 0 },
							data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
						},
						{
							id: 'agent-1',
							type: 'agent',
							position: { x: 200, y: 0 },
							data: { sessionId: 's1', sessionName: 'Agent', toolType: 'claude-code' },
						},
					],
					edges: [{ id: 'e1', source: 'trigger-1', target: 'agent-1', mode: 'pass' }],
				},
			],
			selectedPipelineId: 'p1',
		},
		setPipelineState: mockSetPipelineState,
		isAllPipelinesView: false,
		isDirty: false,
		setIsDirty: vi.fn(),
		saveStatus: 'idle',
		validationErrors: [],
		cueSettings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
		setCueSettings: vi.fn(),
		runningPipelineIds: new Set<string>(),
		persistLayout: mockPersistLayout,
		pendingSavedViewportRef: { current: null },
		handleSave: vi.fn(),
		handleDiscard: vi.fn(),
		createPipeline: vi.fn(),
		deletePipeline: vi.fn(),
		renamePipeline: vi.fn(),
		selectPipeline: vi.fn(),
		changePipelineColor: vi.fn(),
		onUpdateNode: vi.fn(),
		onUpdateEdgePrompt: vi.fn(),
		onDeleteNode: vi.fn(),
		onUpdateEdge: vi.fn(),
		onDeleteEdge: vi.fn(),
	};

	const stableSelectionHook = {
		selectedNodeId: null,
		setSelectedNodeId: vi.fn(),
		selectedEdgeId: null,
		setSelectedEdgeId: vi.fn(),
		selectedNode: null,
		selectedNodePipelineId: null,
		selectedNodeHasOutgoingEdge: false,
		hasIncomingAgentEdges: false,
		incomingAgentEdgeCount: 0,
		incomingTriggerEdges: [],
		selectedEdge: null,
		selectedEdgePipelineId: null,
		selectedEdgePipelineColor: '#06b6d4',
		edgeSourceNode: null,
		edgeTargetNode: null,
		onCanvasSessionIds: new Set<string>(),
		onNodeClick: vi.fn(),
		onEdgeClick: vi.fn(),
		onPaneClick: vi.fn(),
		handleConfigureNode: vi.fn(),
	};

	readDragState = () => stableStateHook;
	readDragSelection = () => stableSelectionHook;
	captureDragCallbacks = (props) => {
		capturedOnNodesChange = props.onNodesChange;
		capturedOnNodeDragStop = props.onNodeDragStop;
	};

	describe('CuePipelineEditor drag logic', () => {
		beforeEach(() => {
			vi.clearAllMocks();
			capturedOnNodesChange = null;
			capturedOnNodeDragStop = null;
		});

		function renderEditor() {
			render(
				<CuePipelineEditor
					sessions={[]}
					graphSessions={[]}
					onSwitchToSession={vi.fn()}
					onClose={vi.fn()}
					theme={mockTheme}
				/>
			);
		}

		it('onNodesChange never commits to pipelineState', () => {
			renderEditor();
			expect(capturedOnNodesChange).toBeTruthy();

			// Mid-drag change
			capturedOnNodesChange([
				{ type: 'position', id: 'p1:agent-1', position: { x: 300, y: 50 }, dragging: true },
			]);
			expect(mockSetPipelineState).not.toHaveBeenCalled();

			// Drag-end change
			capturedOnNodesChange([
				{ type: 'position', id: 'p1:agent-1', position: { x: 350, y: 100 }, dragging: false },
			]);
			expect(mockSetPipelineState).not.toHaveBeenCalled();

			// Selection change
			capturedOnNodesChange([{ type: 'select', id: 'p1:agent-1', selected: true }]);
			expect(mockSetPipelineState).not.toHaveBeenCalled();
			expect(mockPersistLayout).not.toHaveBeenCalled();
		});

		it('onNodeDragStop commits final positions to pipelineState', () => {
			renderEditor();
			expect(capturedOnNodeDragStop).toBeTruthy();

			const mockEvent = {} as React.MouseEvent;
			const draggedNode = { id: 'p1:agent-1', position: { x: 350, y: 100 } };
			capturedOnNodeDragStop(mockEvent, draggedNode, [draggedNode]);

			expect(mockSetPipelineState).toHaveBeenCalledTimes(1);
			expect(mockPersistLayout).toHaveBeenCalledTimes(1);
		});

		it('onNodeDragStop commits multiple nodes simultaneously', () => {
			renderEditor();
			expect(capturedOnNodeDragStop).toBeTruthy();

			const mockEvent = {} as React.MouseEvent;
			const nodes = [
				{ id: 'p1:trigger-1', position: { x: 50, y: 10 } },
				{ id: 'p1:agent-1', position: { x: 350, y: 100 } },
			];
			capturedOnNodeDragStop(mockEvent, nodes[0], nodes);

			expect(mockSetPipelineState).toHaveBeenCalledTimes(1);
			expect(mockPersistLayout).toHaveBeenCalledTimes(1);
		});

		it('onNodeDragStop does nothing with empty nodes', () => {
			renderEditor();
			expect(capturedOnNodeDragStop).toBeTruthy();

			capturedOnNodeDragStop({} as React.MouseEvent, {} as any, []);

			expect(mockSetPipelineState).not.toHaveBeenCalled();
			expect(mockPersistLayout).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('PipelineSelector', () => {
	// The open menu registers with the layer stack (so Escape closes the menu, not
	// the Cue modal around it), which needs the provider the app mounts at its root.
	function render(ui: ReactElement) {
		return rtlRender(<LayerStackProvider>{ui}</LayerStackProvider>);
	}

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

			it('opens tall enough for ten pipelines plus the fixed rows', () => {
				// The 44px filter row, 11 rows of 32 (ten pipelines + All Pipelines),
				// two 1px rules, and the 32px New Pipeline footer.
				expect(openMenu()).toHaveStyle({ height: '430px' });
			});

			it('opens at the floor width when every name is short', () => {
				expect(openMenu()).toHaveStyle({ width: '220px' });
			});

			it('opens wide enough for the longest pipeline name', () => {
				const longName = 'Nightly Dependency Audit And Report';
				const menu = openMenu([
					...mockPipelines,
					{ ...mockPipelines[0], id: 'p3', name: longName },
				]);

				expect(menu.style.width).toBe(`${pipelineMenuDefaultSize([longName]).width}px`);
				expect(parseInt(menu.style.width, 10)).toBeGreaterThan(220);
			});

			it('tracks the cursor 1:1 while dragging and remembers the size', () => {
				const menu = openMenu();

				fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'), { clientX: 0, clientY: 0 });
				fireEvent.mouseMove(document, { clientX: 60, clientY: 40 });

				// Anchored at its top-left, so the menu grows by exactly the drag delta.
				expect(menu.style.width).toBe('280px');
				expect(menu.style.height).toBe('470px');

				fireEvent.mouseUp(document);

				expect(useSettingsStore.getState().modalSizes['cue-pipeline-selector']).toEqual({
					width: 280,
					height: 470,
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
				expect(menu).toHaveStyle({ width: '220px', height: '430px' });
			});
		});
		describe('pipelineMenuDefaultSize', () => {
			it('always leaves room for the All Pipelines row itself', () => {
				expect(pipelineMenuDefaultSize([]).width).toBe(220);
			});

			it('grows with the longest name, not the number of names', () => {
				const one = pipelineMenuDefaultSize(['Nightly Dependency Audit And Report']);
				const many = pipelineMenuDefaultSize([
					'a',
					'b',
					'Nightly Dependency Audit And Report',
					'c',
				]);

				expect(many).toEqual(one);
			});

			it('caps the width so one pathological name cannot size the menu to the screen', () => {
				expect(pipelineMenuDefaultSize(['x'.repeat(500)]).width).toBe(460);
			});

			it('is the same height regardless of how many pipelines exist', () => {
				expect(pipelineMenuDefaultSize([]).height).toBe(pipelineMenuDefaultSize(['a', 'b']).height);
			});

			it('adds room for the Pipelines and Agents labels once agents are listed', () => {
				expect(pipelineMenuDefaultSize(['a'], ['Agent']).height).toBe(
					pipelineMenuDefaultSize(['a']).height + 48
				);
			});

			it('sizes the width to the longest agent name too', () => {
				const longAgent = 'Nightly Dependency Audit And Report';
				expect(pipelineMenuDefaultSize(['a'], [longAgent]).width).toBe(
					pipelineMenuDefaultSize([longAgent]).width
				);
			});
		});

		describe('filter and agents', () => {
			const agents = [
				{ sessionId: 's1', sessionName: 'Deploy Bot', pipelineIds: ['p1'] },
				{ sessionId: 's2', sessionName: 'Reviewer', pipelineIds: ['p1', 'p2'] },
			];

			function openWithAgents(props: Partial<React.ComponentProps<typeof PipelineSelector>> = {}) {
				render(
					<PipelineSelector
						{...defaultProps}
						theme={mockTheme}
						agents={agents}
						onSelectAgent={vi.fn()}
						{...props}
					/>
				);
				fireEvent.click(screen.getByRole('button', { name: /All Pipelines/i }));
				return screen.getByTestId('pipeline-selector-menu');
			}

			it('lists pipelines and agents in labeled sections', () => {
				const menu = openWithAgents();
				expect(within(menu).getByText('Pipelines')).toBeInTheDocument();
				expect(within(menu).getByText('Agents')).toBeInTheDocument();
				expect(screen.getByTestId('pipeline-selector-agent-s1')).toHaveTextContent('Deploy Bot');
				expect(screen.getByTestId('pipeline-selector-agent-s2')).toHaveTextContent('2');
			});

			it('hides the Agents section without an agent handler', () => {
				const menu = openWithAgents({ onSelectAgent: undefined });
				expect(within(menu).queryByText('Agents')).not.toBeInTheDocument();
				expect(screen.queryByTestId('pipeline-selector-agent-s1')).not.toBeInTheDocument();
			});

			it('filters pipelines and agents by one query', () => {
				openWithAgents();
				fireEvent.change(screen.getByPlaceholderText('Filter pipelines and agents...'), {
					target: { value: 'deploy' },
				});

				// "Deploy Pipeline" and the "Deploy Bot" agent match; "Review Pipeline"
				// and the "Reviewer" agent do not.
				expect(screen.getByTestId('pipeline-selector-agent-s1')).toBeInTheDocument();
				expect(screen.queryByTestId('pipeline-selector-agent-s2')).not.toBeInTheDocument();
				expect(screen.queryByText('Review Pipeline')).not.toBeInTheDocument();
			});

			it('says so when nothing matches', () => {
				openWithAgents();
				fireEvent.change(screen.getByPlaceholderText('Filter pipelines and agents...'), {
					target: { value: 'zzz' },
				});
				expect(screen.getByText('No pipelines or agents match "zzz"')).toBeInTheDocument();
			});

			it('selects an agent and closes the menu', () => {
				const onSelectAgent = vi.fn();
				openWithAgents({ onSelectAgent });
				fireEvent.click(screen.getByTestId('pipeline-selector-agent-s2'));
				expect(onSelectAgent).toHaveBeenCalledWith(agents[1]);
				expect(screen.queryByTestId('pipeline-selector-menu')).not.toBeInTheDocument();
			});

			it('takes the first match on Enter, pipelines before agents', () => {
				const onSelect = vi.fn();
				const onSelectAgent = vi.fn();
				openWithAgents({ onSelect, onSelectAgent });
				const input = screen.getByPlaceholderText('Filter pipelines and agents...');

				fireEvent.change(input, { target: { value: 'review' } });
				fireEvent.keyDown(input, { key: 'Enter' });

				expect(onSelect).toHaveBeenCalledWith('p2');
				expect(onSelectAgent).not.toHaveBeenCalled();
			});

			it('takes the first agent on Enter when no pipeline matches', () => {
				const onSelectAgent = vi.fn();
				openWithAgents({ onSelectAgent });
				const input = screen.getByPlaceholderText('Filter pipelines and agents...');

				fireEvent.change(input, { target: { value: 'bot' } });
				fireEvent.keyDown(input, { key: 'Enter' });

				expect(onSelectAgent).toHaveBeenCalledWith(agents[0]);
			});

			it('names the active agent on the trigger', () => {
				render(
					<PipelineSelector
						{...defaultProps}
						theme={mockTheme}
						agents={agents}
						activeAgent={agents[1]}
						onSelectAgent={vi.fn()}
					/>
				);
				const trigger = screen.getByRole('button', { name: /Reviewer/ });
				expect(trigger).toHaveTextContent('2 pipelines');
			});

			it('lets a selected pipeline win over a stale agent on the trigger', () => {
				render(
					<PipelineSelector
						{...defaultProps}
						theme={mockTheme}
						selectedPipelineId="p1"
						agents={agents}
						activeAgent={agents[1]}
						onSelectAgent={vi.fn()}
					/>
				);
				expect(screen.getByRole('button', { name: /Deploy Pipeline/ })).toBeInTheDocument();
				expect(screen.queryByText('Reviewer')).not.toBeInTheDocument();
			});

			it('clears the filter on the first Escape and closes on the second', () => {
				openWithAgents();
				const input = screen.getByPlaceholderText('Filter pipelines and agents...');
				fireEvent.change(input, { target: { value: 'deploy' } });

				fireEvent.keyDown(input, { key: 'Escape' });
				expect(input).toHaveValue('');
				expect(screen.getByTestId('pipeline-selector-menu')).toBeInTheDocument();

				fireEvent.keyDown(input, { key: 'Escape' });
				expect(screen.queryByTestId('pipeline-selector-menu')).not.toBeInTheDocument();
			});

			it('starts with an empty filter every time it opens', () => {
				render(
					<PipelineSelector
						{...defaultProps}
						theme={mockTheme}
						agents={agents}
						onSelectAgent={vi.fn()}
					/>
				);
				// Grab the trigger while it is the only "All Pipelines" button; the
				// open menu adds a second one (the All Pipelines row).
				const trigger = screen.getByRole('button', { name: /All Pipelines/i });
				fireEvent.click(trigger);
				fireEvent.change(screen.getByPlaceholderText('Filter pipelines and agents...'), {
					target: { value: 'deploy' },
				});
				fireEvent.click(trigger);
				fireEvent.click(trigger);
				expect(screen.getByPlaceholderText('Filter pipelines and agents...')).toHaveValue('');
			});
		});
	});
});
describe('CuePipelineEditor.initialViewport', () => {
	const mockFitView = vi.fn();
	const mockSetViewport = vi.fn();
	let mockNodesInitialized = false;

	// Stable references across renders - returning a new object literal from the
	// mock every render caused a setState loop in `useEffect(() => setDisplayNodes,
	// [computedNodes])`, which OOM'd the Node worker.
	const mockPendingSavedViewportRef = {
		current: null as null | { x: number; y: number; zoom: number },
	};
	const stablePipelineState = {
		pipelines: [
			{
				id: 'p1',
				name: 'Pipeline 1',
				color: '#06b6d4',
				nodes: [
					{
						id: 'trigger-1',
						type: 'trigger',
						position: { x: 0, y: 0 },
						data: { eventType: 'time.heartbeat', label: 'Test', config: {} },
					},
				],
				edges: [],
			},
		],
		selectedPipelineId: null,
	};
	const stableRunningPipelineIds = new Set<string>();
	const stableCueSettings = {
		timeout_minutes: 30,
		timeout_on_fail: 'break',
		max_concurrent: 1,
		queue_size: 10,
	};
	const stableStateHook = {
		pipelineState: stablePipelineState,
		setPipelineState: vi.fn(),
		isAllPipelinesView: true,
		isDirty: false,
		setIsDirty: vi.fn(),
		saveStatus: 'idle' as const,
		validationErrors: [],
		cueSettings: stableCueSettings,
		setCueSettings: vi.fn(),
		runningPipelineIds: stableRunningPipelineIds,
		persistLayout: vi.fn(),
		pendingSavedViewportRef: mockPendingSavedViewportRef,
		handleSave: vi.fn(),
		handleDiscard: vi.fn(),
		createPipeline: vi.fn(),
		deletePipeline: vi.fn(),
		renamePipeline: vi.fn(),
		selectPipeline: vi.fn(),
		changePipelineColor: vi.fn(),
		onUpdateNode: vi.fn(),
		onUpdateEdgePrompt: vi.fn(),
		onDeleteNode: vi.fn(),
		onUpdateEdge: vi.fn(),
		onDeleteEdge: vi.fn(),
	};

	// Stable mock - see note on stableStateHook above.
	const stableSelectionHook = {
		selectedNodeId: null,
		setSelectedNodeId: vi.fn(),
		selectedEdgeId: null,
		setSelectedEdgeId: vi.fn(),
		selectedNode: null,
		selectedNodePipelineId: null,
		selectedNodeHasOutgoingEdge: false,
		hasIncomingAgentEdges: false,
		incomingAgentEdgeCount: 0,
		incomingTriggerEdges: [],
		selectedEdge: null,
		selectedEdgePipelineId: null,
		selectedEdgePipelineColor: '#06b6d4',
		edgeSourceNode: null,
		edgeTargetNode: null,
		onCanvasSessionIds: new Set<string>(),
		onNodeClick: vi.fn(),
		onEdgeClick: vi.fn(),
		onPaneClick: vi.fn(),
		handleConfigureNode: vi.fn(),
	};

	const mockTheme = {
		name: 'test',
		colors: {
			bgMain: '#1a1a2e',
			bgActivity: '#16213e',
			border: '#333',
			textMain: '#e4e4e7',
			textDim: '#a1a1aa',
			accent: '#06b6d4',
			accentForeground: '#fff',
			success: '#22c55e',
		},
	} as any;

	function renderEditor() {
		return render(
			<CuePipelineEditor
				sessions={[]}
				graphSessions={[]}
				onSwitchToSession={vi.fn()}
				onClose={vi.fn()}
				theme={mockTheme}
			/>
		);
	}

	describe('CuePipelineEditor - initial viewport (regression: empty canvas on first open)', () => {
		afterEach(() => {
			viewportFixture = undefined;
		});
		beforeEach(() => {
			viewportFixture = {
				fitView: mockFitView,
				setViewport: mockSetViewport,
				nodesInitialized: () => mockNodesInitialized,
				state: () => stableStateHook,
				selection: () => stableSelectionHook,
				graphNodes: () => [
					{ id: 'p1:trigger-1', type: 'trigger', position: { x: 0, y: 0 }, data: {} },
				],
			};
			vi.clearAllMocks();
			mockNodesInitialized = false;
			mockPendingSavedViewportRef.current = null;
		});

		it('does NOT fitView when nodes have not yet been measured', () => {
			// Simulates the first render after layout restore - nodes are present
			// in state but ReactFlow's dimension measurement has not completed.
			mockNodesInitialized = false;
			renderEditor();

			expect(mockFitView).not.toHaveBeenCalled();
			expect(mockSetViewport).not.toHaveBeenCalled();
		});

		it('fits view once nodes have been measured (no saved viewport)', () => {
			// Mount with nodesInitialized=false to mirror the real ReactFlow timing
			// (initial render happens before the dimension measurement finishes),
			// then flip to true and rerender so the initial-viewport effect's
			// dependency change drives it post-mount. Asserting after a single
			// mount with nodesInitialized=true would mask a regression where the
			// effect doesn't react to the false→true transition.
			mockNodesInitialized = false;
			mockPendingSavedViewportRef.current = null;
			const { rerender } = renderEditor();

			expect(mockFitView).not.toHaveBeenCalled();

			mockNodesInitialized = true;
			rerender(
				<CuePipelineEditor
					sessions={[]}
					graphSessions={[]}
					onSwitchToSession={vi.fn()}
					onClose={vi.fn()}
					theme={mockTheme}
				/>
			);

			expect(mockFitView).toHaveBeenCalledTimes(1);
			expect(mockSetViewport).not.toHaveBeenCalled();
		});

		it('restores saved viewport immediately on mount (no need to wait for measurement)', () => {
			// setViewport is a pure (x, y, zoom) restore - it doesn't depend on
			// node measurement, so it fires immediately. Waiting for
			// nodesInitialized would briefly show the wrong viewport before
			// snapping to the saved one.
			mockNodesInitialized = false;
			mockPendingSavedViewportRef.current = { x: 100, y: 200, zoom: 1.5 };
			renderEditor();

			expect(mockSetViewport).toHaveBeenCalledWith({ x: 100, y: 200, zoom: 1.5 });
			expect(mockFitView).not.toHaveBeenCalled();
		});

		it('consumes the pending saved viewport after applying it', () => {
			mockNodesInitialized = false;
			mockPendingSavedViewportRef.current = { x: 100, y: 200, zoom: 1.5 };
			renderEditor();

			// Ref is nulled out so the viewport isn't re-applied on subsequent renders
			// (e.g. after selection changes trigger the other fitView effect).
			expect(mockPendingSavedViewportRef.current).toBeNull();
		});

		it('runs the initial viewport step exactly once', () => {
			mockNodesInitialized = false;
			mockPendingSavedViewportRef.current = null;
			const { rerender } = renderEditor();

			mockNodesInitialized = true;
			rerender(
				<CuePipelineEditor
					sessions={[]}
					graphSessions={[]}
					onSwitchToSession={vi.fn()}
					onClose={vi.fn()}
					theme={mockTheme}
				/>
			);

			expect(mockFitView).toHaveBeenCalledTimes(1);

			// Subsequent renders must NOT re-fit - that's the job of the
			// selection-change fitView effect, not the initial one.
			rerender(
				<CuePipelineEditor
					sessions={[]}
					graphSessions={[]}
					onSwitchToSession={vi.fn()}
					onClose={vi.fn()}
					theme={mockTheme}
				/>
			);

			expect(mockFitView).toHaveBeenCalledTimes(1);
		});
	});
});
