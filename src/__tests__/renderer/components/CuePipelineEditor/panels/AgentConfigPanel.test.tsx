import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AgentConfigPanel } from '../../../../../renderer/components/CuePipelineEditor/panels/AgentConfigPanel';
import { THEMES } from '../../../../../renderer/constants/themes';
import {
	__resetPendingEditsRegistryForTests,
	flushAllPendingEdits,
} from '../../../../../renderer/hooks/cue/pendingEditsRegistry';
import type {
	AgentNodeData,
	CuePipeline,
	IncomingAgentEdgeInfo,
	IncomingTriggerEdgeInfo,
	PipelineEdge,
	PipelineNode,
	TriggerNodeData,
} from '../../../../../shared/cue-pipeline-types';

const theme = THEMES['dracula'];

function agentNode(id = 'agent-1', overrides: Partial<AgentNodeData> = {}): PipelineNode {
	return {
		id,
		type: 'agent',
		position: { x: 0, y: 0 },
		data: {
			sessionId: `session-${id}`,
			sessionName: `Agent ${id}`,
			toolType: 'claude-code',
			inputPrompt: 'Initial input',
			outputPrompt: 'Initial output',
			...overrides,
		} as AgentNodeData,
	};
}

function triggerNode(id: string, eventType: string): PipelineNode {
	return {
		id,
		type: 'trigger',
		position: { x: 0, y: 0 },
		data: {
			eventType,
			label: id,
			config: {},
		} as TriggerNodeData,
	};
}

function edge(
	id: string,
	source: string,
	target: string,
	overrides: Partial<PipelineEdge> = {}
): PipelineEdge {
	return { id, source, target, mode: 'pass', ...overrides };
}

function pipeline(nodes: PipelineNode[], edges: PipelineEdge[] = []): CuePipeline {
	return {
		id: 'pipe-1',
		name: 'Primary Pipeline',
		color: '#06b6d4',
		nodes,
		edges,
	};
}

function incomingAgentEdge(overrides: Partial<IncomingAgentEdgeInfo> = {}): IncomingAgentEdgeInfo {
	return {
		edgeId: 'agent-edge-1',
		sourceNodeId: 'agent-source',
		sourceSessionName: 'Source Agent',
		includeUpstreamOutput: true,
		forwardOutput: false,
		...overrides,
	};
}

function incomingTriggerEdge(
	overrides: Partial<IncomingTriggerEdgeInfo> = {}
): IncomingTriggerEdgeInfo {
	return {
		edgeId: 'trigger-edge-1',
		triggerLabel: 'Heartbeat',
		configSummary: 'Every 30 min',
		prompt: 'Trigger prompt',
		...overrides,
	};
}

function renderPanel(
	props: Partial<React.ComponentProps<typeof AgentConfigPanel>> = {},
	node = agentNode()
) {
	return render(
		<AgentConfigPanel node={node} theme={theme} pipelines={[]} onUpdateNode={vi.fn()} {...props} />
	);
}

afterEach(() => {
	vi.useRealTimers();
	__resetPendingEditsRegistryForTests();
});

describe('AgentConfigPanel', () => {
	it('writes single-trigger input prompt updates to the trigger edge', () => {
		vi.useFakeTimers();
		const onUpdateEdgePrompt = vi.fn();
		renderPanel({
			incomingTriggerEdges: [incomingTriggerEdge()],
			onUpdateEdgePrompt,
			hasOutgoingEdge: true,
		});

		const input = screen.getByDisplayValue('Trigger prompt');
		fireEvent.change(input, { target: { value: 'Updated trigger prompt' } });

		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(onUpdateEdgePrompt).toHaveBeenCalledWith('trigger-edge-1', 'Updated trigger prompt');
		expect(screen.getByText('22 chars')).toBeInTheDocument();
	});

	it('falls back to node-level input prompt when there is no trigger edge prompt sink', () => {
		vi.useFakeTimers();
		const onUpdateNode = vi.fn();
		renderPanel({ onUpdateNode }, agentNode('agent-1', { inputPrompt: 'Node input' }));

		fireEvent.change(screen.getByDisplayValue('Node input'), { target: { value: 'Node update' } });

		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { inputPrompt: 'Node update' });
	});

	it('uses empty prompt defaults when input and output prompts are undefined', () => {
		renderPanel(
			{ hasOutgoingEdge: true },
			agentNode('agent-1', { inputPrompt: undefined, outputPrompt: undefined })
		);

		const textareas = screen.getAllByRole('textbox');
		expect(textareas[0]).toHaveValue('');
		expect(textareas[1]).toHaveValue('');
	});

	it('updates output prompt only when an outgoing edge enables it', () => {
		vi.useFakeTimers();
		const onUpdateNode = vi.fn();
		const { rerender } = renderPanel(
			{ onUpdateNode, hasOutgoingEdge: false },
			agentNode('agent-1', { outputPrompt: 'Blocked output' })
		);

		expect(screen.getByDisplayValue('Blocked output')).toBeDisabled();

		rerender(
			<AgentConfigPanel
				node={agentNode('agent-1', { outputPrompt: 'Enabled output' })}
				theme={theme}
				pipelines={[]}
				hasOutgoingEdge
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.change(screen.getByDisplayValue('Enabled output'), {
			target: { value: 'Send this onward' },
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { outputPrompt: 'Send this onward' });
	});

	it('renders multi-trigger prompt rows and flushes edge prompt edits', () => {
		vi.useFakeTimers();
		const onUpdateEdgePrompt = vi.fn();
		renderPanel({
			incomingTriggerEdges: [
				incomingTriggerEdge({ edgeId: 'trigger-edge-1', triggerLabel: 'Heartbeat' }),
				incomingTriggerEdge({
					edgeId: 'trigger-edge-2',
					triggerLabel: 'GitHub PR',
					configSummary: 'Pull request',
					prompt: 'PR prompt',
				}),
			],
			onUpdateEdgePrompt,
			hasOutgoingEdge: true,
			expanded: true,
		});

		expect(screen.getByText('Heartbeat')).toBeInTheDocument();
		expect(screen.getByText('Pull request')).toBeInTheDocument();

		fireEvent.change(screen.getByDisplayValue('PR prompt'), {
			target: { value: 'Updated PR prompt' },
		});
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(onUpdateEdgePrompt).toHaveBeenCalledWith('trigger-edge-2', 'Updated PR prompt');
	});

	it('shows upstream source controls and fan-in options for multi-agent input', () => {
		const onUpdateEdge = vi.fn();
		const onUpdateNode = vi.fn();
		renderPanel(
			{
				onUpdateNode,
				onUpdateEdge,
				hasOutgoingEdge: true,
				hasIncomingAgentEdges: true,
				incomingAgentEdgeCount: 2,
				incomingAgentEdges: [
					incomingAgentEdge({
						edgeId: 'edge-a',
						sourceNodeId: 'source-a',
						sourceSessionName: 'Agent A',
					}),
					incomingAgentEdge({
						edgeId: 'edge-b',
						sourceNodeId: 'source-b',
						sourceSessionName: 'Agent B',
						includeUpstreamOutput: false,
						forwardOutput: true,
					}),
				],
			},
			agentNode('agent-1', { fanInTimeoutMinutes: 5, fanInTimeoutOnFail: 'break' })
		);

		fireEvent.click(screen.getAllByLabelText('Include', { selector: 'input' })[0]);
		expect(onUpdateEdge).toHaveBeenCalledWith('edge-a', { includeUpstreamOutput: false });

		fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '12' } });
		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { fanInTimeoutMinutes: 12 });

		fireEvent.click(screen.getByRole('button', { name: /Wait for all/i }));
		fireEvent.click(screen.getByRole('option', { name: 'Continue with partial' }));
		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { fanInTimeoutOnFail: 'continue' });
		expect(screen.getByText(/2 agents/)).toBeInTheDocument();
	});

	it('shows GitHub trigger placeholders, pipeline membership, forwarded sources, and switch action', () => {
		const onSwitchToAgent = vi.fn();
		const target = agentNode('agent-target', {
			sessionId: 'session-shared',
			sessionName: 'Target Agent',
			inputPrompt: '',
		});
		const source = agentNode('agent-source', {
			sessionId: 'session-source',
			sessionName: 'Source Agent',
		});
		const githubTrigger = triggerNode('trigger-gh', 'github.pull_request');
		const pipe = pipeline(
			[source, target, githubTrigger],
			[
				edge('source-target', source.id, target.id, { forwardOutput: true }),
				edge('trigger-target', githubTrigger.id, target.id),
			]
		);

		renderPanel(
			{
				pipelines: [pipe],
				hasOutgoingEdge: true,
				onSwitchToAgent,
			},
			target
		);

		expect(screen.getByPlaceholderText(/CUE_GH_URL/)).toBeInTheDocument();
		expect(screen.getByText('Primary Pipeline')).toBeInTheDocument();
		expect(screen.getByText('Switch to Agent')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Switch to Agent/i }));
		expect(onSwitchToAgent).toHaveBeenCalledWith('session-shared');
	});

	it('handles unrelated and duplicate owning pipelines while listing memberships', () => {
		const target = agentNode('agent-target', {
			sessionId: 'session-shared',
			sessionName: 'Target Agent',
		});
		const unrelated = agentNode('agent-unrelated', {
			sessionId: 'session-unrelated',
			sessionName: 'Unrelated Agent',
		});
		const primary = pipeline([target], []);
		const duplicateOwner: CuePipeline = {
			...pipeline([{ ...target }], []),
			id: 'pipe-2',
			name: 'Secondary Pipeline',
			color: '#f97316',
		};
		const unrelatedPipeline: CuePipeline = {
			...pipeline([unrelated], []),
			id: 'pipe-3',
			name: 'Unrelated Pipeline',
			color: '#22c55e',
		};

		renderPanel(
			{
				pipelines: [primary, duplicateOwner, unrelatedPipeline],
				hasOutgoingEdge: true,
			},
			target
		);

		expect(screen.getByText('Primary Pipeline')).toBeInTheDocument();
		expect(screen.getByText('Secondary Pipeline')).toBeInTheDocument();
		expect(screen.queryByText('Unrelated Pipeline')).not.toBeInTheDocument();
	});

	it('shows GitHub issue placeholders when an issue trigger feeds the agent', () => {
		const target = agentNode('agent-target', { inputPrompt: '' });
		const githubTrigger = triggerNode('trigger-gh', 'github.issue');
		const pipe = pipeline(
			[target, githubTrigger],
			[edge('trigger-target', githubTrigger.id, target.id)]
		);

		renderPanel({ pipelines: [pipe], hasOutgoingEdge: true }, target);

		expect(screen.getByPlaceholderText(/CUE_GH_URL/)).toBeInTheDocument();
	});

	it('uses the upstream variable hint when upstream output is not auto-included', () => {
		renderPanel({
			hasOutgoingEdge: true,
			hasIncomingAgentEdges: true,
			incomingAgentEdges: [
				incomingAgentEdge({
					edgeId: 'edge-a',
					sourceNodeId: 'source-a',
					sourceSessionName: 'Agent A',
					includeUpstreamOutput: false,
				}),
			],
		});

		expect(screen.getByPlaceholderText(/per-source variables/)).toBeInTheDocument();
	});

	it('clears fan-in overrides back to global defaults', () => {
		const onUpdateNode = vi.fn();
		const { rerender } = renderPanel(
			{
				onUpdateNode,
				hasOutgoingEdge: true,
				incomingAgentEdgeCount: 2,
			},
			agentNode('agent-1', { fanInTimeoutMinutes: undefined, fanInTimeoutOnFail: undefined })
		);
		expect(screen.getByRole('button', { name: /Global default/i })).toBeInTheDocument();

		rerender(
			<AgentConfigPanel
				node={agentNode('agent-1', { fanInTimeoutMinutes: 5, fanInTimeoutOnFail: 'break' })}
				theme={theme}
				pipelines={[]}
				hasOutgoingEdge
				incomingAgentEdgeCount={2}
				onUpdateNode={onUpdateNode}
			/>
		);

		fireEvent.change(screen.getByDisplayValue('5'), { target: { value: '' } });
		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { fanInTimeoutMinutes: undefined });

		fireEvent.click(screen.getByRole('button', { name: /Wait for all/i }));
		fireEvent.click(screen.getByRole('option', { name: 'Global default' }));
		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { fanInTimeoutOnFail: undefined });
	});

	it('flushes pending prompt writes when unmounted', () => {
		vi.useFakeTimers();
		const onUpdateNode = vi.fn();
		const { unmount } = renderPanel(
			{ onUpdateNode },
			agentNode('agent-1', { inputPrompt: 'Before' })
		);

		fireEvent.change(screen.getByDisplayValue('Before'), { target: { value: 'Unmount flush' } });
		unmount();

		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { inputPrompt: 'Unmount flush' });
	});

	it('flushes pending prompt writes through the registry before save', () => {
		vi.useFakeTimers();
		const onUpdateNode = vi.fn();
		renderPanel(
			{ onUpdateNode, hasOutgoingEdge: true },
			agentNode('agent-1', { inputPrompt: 'Before' })
		);

		fireEvent.change(screen.getByDisplayValue('Before'), { target: { value: 'Registry flush' } });
		flushAllPendingEdits();

		expect(onUpdateNode).toHaveBeenCalledWith('agent-1', { inputPrompt: 'Registry flush' });
	});
});
