import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TriggerNode } from '../../../../../renderer/components/CuePipelineEditor/nodes/TriggerNode';
import { ReactFlowProvider } from 'reactflow';
import type { NodeProps } from 'reactflow';
import type { TriggerNodeDataProps } from '../../../../../renderer/components/CuePipelineEditor/nodes/TriggerNode';
import { THEMES } from '../../../../../renderer/constants/themes';

const defaultData: TriggerNodeDataProps = {
	compositeId: 'pipeline-1:trigger-0',
	eventType: 'time.heartbeat',
	label: 'Heartbeat',
	configSummary: 'every 5min',
};

function renderTriggerNode(overrides: Partial<TriggerNodeDataProps> = {}, selected = false) {
	const data = { ...defaultData, ...overrides };
	const props = {
		id: 'test-trigger',
		data,
		type: 'trigger',
		selected,
		isConnectable: true,
		xPos: 0,
		yPos: 0,
		zIndex: 0,
		dragging: false,
	} as NodeProps<TriggerNodeDataProps>;

	return render(
		<ReactFlowProvider>
			<TriggerNode {...props} />
		</ReactFlowProvider>
	);
}

describe('TriggerNode', () => {
	it('should render label and config summary', () => {
		renderTriggerNode();

		expect(screen.getByText('Heartbeat')).toBeInTheDocument();
		expect(screen.getByText('every 5min')).toBeInTheDocument();
	});

	it('should render a drag handle', () => {
		const { container } = renderTriggerNode();
		const dragHandle = container.querySelector('.drag-handle');
		expect(dragHandle).not.toBeNull();
	});

	it('should render a gear icon for configuration', () => {
		const { container } = renderTriggerNode();
		const gearButton = container.querySelector('[title="Configure"]');
		expect(gearButton).not.toBeNull();
	});

	it('should show title tooltip on the label span', () => {
		renderTriggerNode({ label: 'My Custom Label' });

		const labelSpan = screen.getByText('My Custom Label');
		expect(labelSpan).toHaveAttribute('title', 'My Custom Label');
	});

	it('should show title tooltip on the config summary span', () => {
		renderTriggerNode({ configSummary: 'every 10min' });

		const summarySpan = screen.getByText('every 10min');
		expect(summarySpan).toHaveAttribute('title', 'every 10min');
	});

	it('should show tooltip with full text for long labels', () => {
		const longLabel = 'This is a very long trigger label that will be truncated';
		renderTriggerNode({ label: longLabel });

		const labelSpan = screen.getByText(longLabel);
		expect(labelSpan).toHaveAttribute('title', longLabel);
	});

	it('should show tooltip with full text for long config summaries', () => {
		const longSummary = 'Mon, Tue, Wed, Thu, Fri at 09:00, 12:00, 15:00, 18:00';
		renderTriggerNode({ configSummary: longSummary });

		const summarySpan = screen.getByText(longSummary);
		expect(summarySpan).toHaveAttribute('title', longSummary);
	});

	it('should use minWidth and grow to fit content instead of fixed width', () => {
		const { container } = renderTriggerNode();

		const rootDiv = container.querySelector('div[style*="min-width: 220px"]') as HTMLElement;
		expect(rootDiv).not.toBeNull();
		// Node grows to fit content rather than capping at a fixed maxWidth.
		expect(rootDiv.style.width).toBe('max-content');
		expect(rootDiv.style.maxWidth).toBe('');
	});

	it('should not render config summary when empty', () => {
		renderTriggerNode({ configSummary: '' });

		// The summary span should not be in the DOM
		expect(screen.queryByText('every 5min')).not.toBeInTheDocument();
	});

	it('should call onConfigure when gear icon is clicked', () => {
		const onConfigure = vi.fn();
		const { container } = renderTriggerNode({
			onConfigure,
			compositeId: 'pipeline-1:trigger-0',
		});

		const gearButton = container.querySelector('[title="Configure"]') as HTMLElement;
		gearButton.click();

		expect(onConfigure).toHaveBeenCalledWith('pipeline-1:trigger-0');
	});

	it('should apply selection styling when selected', () => {
		const { container: selectedContainer } = renderTriggerNode({}, true);
		const { container: unselectedContainer } = renderTriggerNode({}, false);

		const selectedRoot = selectedContainer.querySelector(
			'div[style*="min-width: 220px"]'
		) as HTMLElement;
		const unselectedRoot = unselectedContainer.querySelector(
			'div[style*="min-width: 220px"]'
		) as HTMLElement;

		// Selected and unselected should have different border colors
		expect(selectedRoot.style.borderColor).not.toBe(unselectedRoot.style.borderColor);
		// Selected should have a box shadow, unselected should not
		expect(selectedRoot.style.boxShadow).toBeTruthy();
		expect(unselectedRoot.style.boxShadow).toBeFalsy();
	});

	describe('play button', () => {
		it('renders when isSaved, pipelineName, and onTriggerPipeline are provided', () => {
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'my-pipeline',
				isSaved: true,
			});

			const playButton = container.querySelector('[title="Run now"]');
			expect(playButton).not.toBeNull();
		});

		it('is hidden when isSaved is false', () => {
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'my-pipeline',
				isSaved: false,
			});

			expect(container.querySelector('[title="Run now"]')).toBeNull();
		});

		it('is hidden when onTriggerPipeline is undefined', () => {
			const { container } = renderTriggerNode({
				pipelineName: 'my-pipeline',
				isSaved: true,
			});

			expect(container.querySelector('[title="Run now"]')).toBeNull();
		});

		it('is hidden when pipelineName is undefined', () => {
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				isSaved: true,
			});

			expect(container.querySelector('[title="Run now"]')).toBeNull();
		});

		it('calls onTriggerPipeline with pipeline name when clicked', () => {
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'test-pipeline',
				isSaved: true,
			});

			const playButton = container.querySelector('[title="Run now"]') as HTMLElement;
			playButton.click();

			expect(onTriggerPipeline).toHaveBeenCalledWith('test-pipeline');
		});

		it('shows "Running…" tooltip when isRunning is true', () => {
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'my-pipeline',
				isSaved: true,
				isRunning: true,
			});

			expect(container.querySelector('[title="Running…"]')).not.toBeNull();
			expect(container.querySelector('[title="Run now"]')).toBeNull();
		});

		it('does not call onTriggerPipeline when isRunning and clicked', () => {
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'my-pipeline',
				isSaved: true,
				isRunning: true,
			});

			const runningButton = container.querySelector('[title="Running…"]') as HTMLElement;
			runningButton.click();

			expect(onTriggerPipeline).not.toHaveBeenCalled();
		});

		it('gear icon still works alongside play button', () => {
			const onConfigure = vi.fn();
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onConfigure,
				onTriggerPipeline,
				pipelineName: 'my-pipeline',
				isSaved: true,
				compositeId: 'pipeline-1:trigger-0',
			});

			// Both buttons should exist
			expect(container.querySelector('[title="Run now"]')).not.toBeNull();
			expect(container.querySelector('[title="Configure"]')).not.toBeNull();

			// Gear still works
			const gearButton = container.querySelector('[title="Configure"]') as HTMLElement;
			gearButton.click();
			expect(onConfigure).toHaveBeenCalledWith('pipeline-1:trigger-0');
		});

		it("fires the trigger node's OWN subscription (chain sub), not the pipeline name, when clicked", () => {
			// Regression: multi-trigger pipelines (e.g. startup + scheduled +
			// GitHub PR all under "Pipeline 1") produce subscriptions named
			// "Pipeline 1", "Pipeline 1-chain-1", "Pipeline 1-chain-2".
			// Before this fix, every Play button sent "Pipeline 1" regardless
			// of which trigger was clicked — chain triggers (including
			// GitHub PR/Issue polls) were unreachable from the UI.
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'Pipeline 1',
				subscriptionName: 'Pipeline 1-chain-2',
				isSaved: true,
			});

			const playButton = container.querySelector('[title="Run now"]') as HTMLElement;
			playButton.click();

			expect(onTriggerPipeline).toHaveBeenCalledTimes(1);
			expect(onTriggerPipeline).toHaveBeenCalledWith('Pipeline 1-chain-2');
			expect(onTriggerPipeline).not.toHaveBeenCalledWith('Pipeline 1');
		});

		it('falls back to pipelineName when subscriptionName is missing (never-saved or legacy state)', () => {
			// Defensive: single-trigger pipelines that predate the fix still
			// work because subscriptionName defaults to the pipeline name.
			const onTriggerPipeline = vi.fn();
			const { container } = renderTriggerNode({
				onTriggerPipeline,
				pipelineName: 'legacy-pipeline',
				isSaved: true,
			});

			const playButton = container.querySelector('[title="Run now"]') as HTMLElement;
			playButton.click();

			expect(onTriggerPipeline).toHaveBeenCalledWith('legacy-pipeline');
		});

		it('aria-label uses the subscription name so screen readers announce the correct trigger', () => {
			const { container } = renderTriggerNode({
				onTriggerPipeline: vi.fn(),
				pipelineName: 'Pipeline 1',
				subscriptionName: 'Pipeline 1-chain-2',
				isSaved: true,
			});
			const playButton = container.querySelector('[aria-label="Run Pipeline 1-chain-2"]');
			expect(playButton).not.toBeNull();
		});
	});

	it('should use theme textDim color for config summary when theme provided', () => {
		const lightTheme = THEMES['github-light'];
		const { container } = renderTriggerNode({ theme: lightTheme, configSummary: 'every 30min' });
		const summarySpan = container.querySelector('span[title="every 30min"]') as HTMLElement;
		expect(summarySpan).toBeInTheDocument();
		expect(summarySpan).toHaveStyle({ color: lightTheme.colors.textDim });
	});

	it('should use theme textDim color for drag handle when theme provided', () => {
		const darkTheme = THEMES['dracula'];
		const { container } = renderTriggerNode({ theme: darkTheme });
		const dragHandle = container.querySelector('.drag-handle') as HTMLElement;
		expect(dragHandle).toBeInTheDocument();
		expect(dragHandle).toHaveStyle({ color: darkTheme.colors.textDim });
	});

	it('should fall back to hardcoded textDim when no theme provided', () => {
		const { container } = renderTriggerNode({ configSummary: 'every 10min' });
		const summarySpan = container.querySelector('span[title="every 10min"]') as HTMLElement;
		expect(summarySpan).toBeInTheDocument();
		expect(summarySpan).toHaveStyle({ color: '#9ca3af' });
	});

	it('should use correct color for each event type', () => {
		const eventColors: Record<string, string> = {
			'time.heartbeat': '#f59e0b',
			'time.scheduled': '#8b5cf6',
			'file.changed': '#3b82f6',
			'agent.completed': '#22c55e',
			'github.pull_request': '#a855f7',
			'github.issue': '#f97316',
			'task.pending': '#06b6d4',
		};

		for (const [eventType, expectedColor] of Object.entries(eventColors)) {
			const { unmount } = renderTriggerNode({
				eventType: eventType as TriggerNodeDataProps['eventType'],
				label: eventType,
			});

			const labelSpan = screen.getByText(eventType);
			expect(labelSpan).toHaveStyle({ color: expectedColor });

			unmount();
		}
	});
});
