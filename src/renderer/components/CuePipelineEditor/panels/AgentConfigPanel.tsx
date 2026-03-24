/**
 * AgentConfigPanel — Configuration panel for agent nodes in the pipeline.
 *
 * Handles input/output prompts, single-trigger vs multi-trigger modes,
 * upstream output inclusion, and pipeline membership display.
 */

import { useState, useEffect, useCallback } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Theme } from '../../../types';
import {
	CUE_COLOR,
	type PipelineNode,
	type AgentNodeData,
	type CuePipeline,
} from '../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../hooks/utils';
import type { IncomingTriggerEdgeInfo } from './NodeConfigPanel';
import { EdgePromptRow } from './EdgePromptRow';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';

interface AgentConfigPanelProps {
	node: PipelineNode;
	theme: Theme;
	pipelines: CuePipeline[];
	hasOutgoingEdge?: boolean;
	hasIncomingAgentEdges?: boolean;
	incomingTriggerEdges?: IncomingTriggerEdgeInfo[];
	onUpdateNode: (nodeId: string, data: Partial<AgentNodeData>) => void;
	onUpdateEdgePrompt?: (edgeId: string, prompt: string) => void;
	onSwitchToAgent?: (sessionId: string) => void;
	expanded?: boolean;
}

export function AgentConfigPanel({
	node,
	theme,
	pipelines,
	hasOutgoingEdge,
	hasIncomingAgentEdges,
	incomingTriggerEdges,
	onUpdateNode,
	onUpdateEdgePrompt,
	onSwitchToAgent,
	expanded,
}: AgentConfigPanelProps) {
	const data = node.data as AgentNodeData;
	const hasMultipleTriggers = (incomingTriggerEdges?.length ?? 0) > 1;

	const themedInputStyle = getInputStyle(theme);
	const themedLabelStyle = getLabelStyle(theme);

	// Single-trigger mode: use agent node's inputPrompt (existing behavior)
	const [localInputPrompt, setLocalInputPrompt] = useState(data.inputPrompt ?? '');
	const [localOutputPrompt, setLocalOutputPrompt] = useState(data.outputPrompt ?? '');

	useEffect(() => {
		setLocalInputPrompt(data.inputPrompt ?? '');
	}, [data.inputPrompt]);

	useEffect(() => {
		setLocalOutputPrompt(data.outputPrompt ?? '');
	}, [data.outputPrompt]);

	const { debouncedCallback: debouncedUpdateInput } = useDebouncedCallback((...args: unknown[]) => {
		const inputPrompt = args[0] as string;
		onUpdateNode(node.id, { inputPrompt } as Partial<AgentNodeData>);
	}, 300);

	const { debouncedCallback: debouncedUpdateOutput } = useDebouncedCallback(
		(...args: unknown[]) => {
			const outputPrompt = args[0] as string;
			onUpdateNode(node.id, { outputPrompt } as Partial<AgentNodeData>);
		},
		300
	);

	const handleInputPromptChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalInputPrompt(e.target.value);
			debouncedUpdateInput(e.target.value);
		},
		[debouncedUpdateInput]
	);

	const handleOutputPromptChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			setLocalOutputPrompt(e.target.value);
			debouncedUpdateOutput(e.target.value);
		},
		[debouncedUpdateOutput]
	);

	// Find which pipelines contain this agent
	const agentPipelines = pipelines.filter((p) =>
		p.nodes.some(
			(n) => n.type === 'agent' && (n.data as AgentNodeData).sessionId === data.sessionId
		)
	);

	const outputDisabled = !hasOutgoingEdge;

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 8,
				flex: expanded ? 1 : undefined,
				minHeight: 0,
			}}
		>
			<div style={{ display: 'flex', gap: 12, flex: expanded ? 1 : undefined, minHeight: 0 }}>
				{/* Input Prompt(s) */}
				{hasMultipleTriggers && onUpdateEdgePrompt ? (
					<div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
						{incomingTriggerEdges!.map((edgeInfo) => (
							<EdgePromptRow
								key={edgeInfo.edgeId}
								edgeInfo={edgeInfo}
								theme={theme}
								onUpdateEdgePrompt={onUpdateEdgePrompt}
								expanded={expanded}
							/>
						))}
					</div>
				) : (
					<div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
						<label
							style={{
								...themedLabelStyle,
								flex: expanded ? 1 : undefined,
								display: 'flex',
								flexDirection: 'column',
								minHeight: 0,
							}}
						>
							Input Prompt
							<textarea
								value={localInputPrompt}
								onChange={handleInputPromptChange}
								rows={expanded ? undefined : 3}
								placeholder={
									hasIncomingAgentEdges && data.includeUpstreamOutput !== false
										? 'Instructions for this agent. Upstream output is auto-included via {{CUE_SOURCE_OUTPUT}}.'
										: hasIncomingAgentEdges
											? 'Instructions for this agent. Use {{CUE_SOURCE_OUTPUT}} to include upstream output.'
											: 'Prompt sent when this agent receives data from the pipeline...'
								}
								style={{
									...themedInputStyle,
									resize: 'vertical',
									fontFamily: 'inherit',
									lineHeight: 1.4,
									...(expanded ? { flex: 1, minHeight: 0 } : { minHeight: 72 }),
								}}
							/>
						</label>
						{hasIncomingAgentEdges && (
							<>
								<label
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 6,
										fontSize: 11,
										color: theme.colors.textDim,
										cursor: 'pointer',
										marginTop: 2,
									}}
								>
									<input
										type="checkbox"
										checked={data.includeUpstreamOutput !== false}
										onChange={(e) =>
											onUpdateNode(node.id, {
												includeUpstreamOutput: e.target.checked,
											} as Partial<AgentNodeData>)
										}
										style={{ accentColor: CUE_COLOR }}
									/>
									Auto-include upstream output
								</label>
								<div style={{ color: theme.colors.textDim, fontSize: 10, marginTop: 2 }}>
									Use {'{{CUE_SOURCE_OUTPUT}}'} in your prompt to control placement.
								</div>
							</>
						)}
						<div
							style={{
								color: theme.colors.textDim,
								fontSize: 10,
								textAlign: 'right',
								flexShrink: 0,
							}}
						>
							{localInputPrompt.length} chars
						</div>
					</div>
				)}

				{/* Output Prompt */}
				<div
					style={{
						flex: hasMultipleTriggers ? 0 : 1,
						minWidth: hasMultipleTriggers ? 200 : undefined,
						display: 'flex',
						flexDirection: 'column',
						opacity: outputDisabled ? 0.35 : 1,
						transition: 'opacity 0.15s',
						minHeight: 0,
					}}
				>
					<label
						style={{
							...themedLabelStyle,
							flex: expanded ? 1 : undefined,
							display: 'flex',
							flexDirection: 'column',
							minHeight: 0,
						}}
					>
						Output Prompt
						<textarea
							value={localOutputPrompt}
							onChange={handleOutputPromptChange}
							rows={expanded ? undefined : 3}
							disabled={outputDisabled}
							placeholder={
								outputDisabled
									? 'Connect an outgoing edge to enable...'
									: 'Prompt executed after task completion to pass data to next agent...'
							}
							style={{
								...themedInputStyle,
								resize: 'vertical',
								fontFamily: 'inherit',
								lineHeight: 1.4,
								cursor: outputDisabled ? 'not-allowed' : undefined,
								...(expanded ? { flex: 1, minHeight: 0 } : { minHeight: 72 }),
							}}
						/>
					</label>
					<div
						style={{ color: theme.colors.textDim, fontSize: 10, textAlign: 'right', flexShrink: 0 }}
					>
						{localOutputPrompt.length} chars
					</div>
				</div>
			</div>

			<div
				style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', flexShrink: 0 }}
			>
				{agentPipelines.length > 0 && (
					<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
						{agentPipelines.map((p) => (
							<span
								key={p.id}
								style={{
									display: 'inline-flex',
									alignItems: 'center',
									gap: 4,
									fontSize: 11,
									color: theme.colors.textDim,
								}}
							>
								<span
									style={{
										width: 8,
										height: 8,
										borderRadius: '50%',
										backgroundColor: p.color,
										display: 'inline-block',
									}}
								/>
								{p.name}
							</span>
						))}
					</div>
				)}

				{onSwitchToAgent && (
					<button
						onClick={() => onSwitchToAgent(data.sessionId)}
						style={{
							display: 'inline-flex',
							alignItems: 'center',
							gap: 4,
							padding: '4px 10px',
							fontSize: 11,
							fontWeight: 500,
							color: CUE_COLOR,
							backgroundColor: 'transparent',
							border: `1px solid ${CUE_COLOR}40`,
							borderRadius: 4,
							cursor: 'pointer',
						}}
					>
						<ExternalLink size={11} />
						Switch to Agent
					</button>
				)}
			</div>
		</div>
	);
}
