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
	sanitizeVarName,
	type PipelineNode,
	type PipelineEdge,
	type AgentNodeData,
	type TriggerNodeData,
	type CuePipeline,
	type IncomingAgentEdgeInfo,
} from '../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../hooks/utils';
import type { IncomingTriggerEdgeInfo } from './NodeConfigPanel';
import { EdgePromptRow } from './EdgePromptRow';
import { CueSelect } from './CueSelect';
import { getInputStyle, getLabelStyle } from './triggers/triggerConfigStyles';

interface AgentConfigPanelProps {
	node: PipelineNode;
	theme: Theme;
	pipelines: CuePipeline[];
	hasOutgoingEdge?: boolean;
	hasIncomingAgentEdges?: boolean;
	incomingAgentEdgeCount?: number;
	incomingAgentEdges?: IncomingAgentEdgeInfo[];
	incomingTriggerEdges?: IncomingTriggerEdgeInfo[];
	onUpdateNode: (nodeId: string, data: Partial<AgentNodeData>) => void;
	onUpdateEdge?: (edgeId: string, updates: Partial<PipelineEdge>) => void;
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
	incomingAgentEdgeCount,
	incomingAgentEdges,
	incomingTriggerEdges,
	onUpdateNode,
	onUpdateEdge,
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

	// Detect if this agent has an incoming edge from a GitHub trigger
	const hasGitHubTrigger = agentPipelines.some((p) => {
		const incomingEdges = p.edges.filter((e) => e.target === node.id);
		return incomingEdges.some((e) => {
			const sourceNode = p.nodes.find((n) => n.id === e.source);
			if (sourceNode?.type !== 'trigger') return false;
			const triggerData = sourceNode.data as TriggerNodeData;
			return (
				triggerData.eventType === 'github.pull_request' || triggerData.eventType === 'github.issue'
			);
		});
	});

	const outputDisabled = !hasOutgoingEdge;

	const hasFanIn = (incomingAgentEdgeCount ?? 0) > 1;

	// Layout policy:
	//
	// - The input/output split is a flex row that fills all remaining vertical
	//   space (`flex: 1, minHeight: 0`). Both columns get `flex: 1` so the
	//   output box always fills its column instead of collapsing to its content
	//   (the previous `flex: hasMultipleTriggers ? 0 : 1` left dead space below
	//   the output textarea in multi-trigger collapsed mode).
	//
	// - Single-trigger input and the output textarea both use `flex: 1,
	//   minHeight: 0` regardless of expanded/collapsed, so they grow to fill
	//   the available column height — no more wasted whitespace in collapsed
	//   single-trigger mode.
	//
	// - Multi-trigger left column has its OWN `overflowY: auto` and lays out
	//   each EdgePromptRow at its intrinsic content size (no row-level flex).
	//   This is what stops textareas from being squeezed under their own
	//   labels, and what prevents the bottom row's title from overlapping the
	//   row above when the parent runs out of vertical space — instead of
	//   collapsing rows below their min content size, the column scrolls.
	//
	// - The outer container does NOT add its own overflow: NodeConfigPanel's
	//   content wrapper sets overflow: hidden on this branch, so we have a
	//   single source of scrolling per axis (left rail in multi-trigger mode,
	//   nothing for the rest in collapsed mode — both prompts fit). The
	//   trailing fan-in / pipeline-pills section uses flexShrink: 0 so it
	//   never steals space from the prompts.
	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: 10,
				flex: 1,
				minHeight: 0,
				minWidth: 0,
			}}
		>
			<div
				style={{
					display: 'flex',
					gap: 12,
					// When upstream-sources or fan-in cards sit below, the prompts
					// row must not greedily eat all available height. Use flex: 1
					// with a sane minHeight so the row shrinks and the panel scrolls
					// if needed, keeping the cards reachable.
					flex: 1,
					minHeight: hasIncomingAgentEdges ? 100 : 0,
					minWidth: 0,
				}}
			>
				{/* Input Prompt(s) */}
				{hasMultipleTriggers && onUpdateEdgePrompt ? (
					<div
						style={{
							flex: 1,
							minWidth: 0,
							minHeight: 0,
							display: 'flex',
							flexDirection: 'column',
							gap: 8,
							overflowY: 'auto',
							overflowX: 'hidden',
							// Reserve space for the scrollbar so rows don't shift when
							// it appears.
							paddingRight: 6,
						}}
					>
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
					<div
						style={{
							flex: 1,
							minWidth: 0,
							minHeight: 0,
							display: 'flex',
							flexDirection: 'column',
						}}
					>
						<label
							style={{
								...themedLabelStyle,
								flex: 1,
								display: 'flex',
								flexDirection: 'column',
								minHeight: 0,
								marginBottom: 0,
							}}
						>
							<span
								style={{
									display: 'flex',
									alignItems: 'baseline',
									gap: 4,
									flexShrink: 0,
									marginBottom: 4,
								}}
							>
								Input Prompt
								{hasIncomingAgentEdges &&
									incomingAgentEdges?.some((e) => e.includeUpstreamOutput) && (
										<span
											style={{
												fontWeight: 400,
												color: theme.colors.textDim,
												fontSize: 10,
											}}
										>
											(optional)
										</span>
									)}
							</span>
							<textarea
								value={localInputPrompt}
								onChange={handleInputPromptChange}
								placeholder={
									hasIncomingAgentEdges && incomingAgentEdges?.some((e) => e.includeUpstreamOutput)
										? 'Optional — upstream output is auto-included. Add instructions to guide how the agent processes it.'
										: hasIncomingAgentEdges
											? 'Instructions for this agent. Use per-source variables from the card below.'
											: hasGitHubTrigger
												? 'Use {{CUE_GH_URL}}, {{CUE_GH_NUMBER}}, {{CUE_GH_TITLE}}, {{CUE_GH_BODY}} etc. for GitHub context...'
												: 'Prompt sent when this agent receives data from the pipeline...'
								}
								style={{
									...themedInputStyle,
									resize: 'vertical',
									fontFamily: 'inherit',
									lineHeight: 1.4,
									flex: 1,
									minHeight: hasFanIn ? 72 : 88,
								}}
							/>
						</label>
						<div
							style={{
								color: theme.colors.textDim,
								fontSize: 10,
								textAlign: 'right',
								flexShrink: 0,
								marginTop: 2,
							}}
						>
							{localInputPrompt.length} chars
						</div>
					</div>
				)}

				{/* Output Prompt — always flex: 1 so it fills the column even when
				 *  the left side is in multi-trigger scroll mode. Previously this
				 *  was `flex: hasMultipleTriggers ? 0 : 1` which collapsed the
				 *  output to its content + minHeight, leaving the rest of the
				 *  column as dead whitespace. */}
				<div
					style={{
						flex: 1,
						minWidth: 0,
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
						opacity: outputDisabled ? 0.35 : 1,
						transition: 'opacity 0.15s',
					}}
				>
					<label
						style={{
							...themedLabelStyle,
							flex: 1,
							display: 'flex',
							flexDirection: 'column',
							minHeight: 0,
							marginBottom: 0,
						}}
					>
						<span
							style={{
								flexShrink: 0,
								marginBottom: 4,
							}}
						>
							Output Prompt
						</span>
						<textarea
							value={localOutputPrompt}
							onChange={handleOutputPromptChange}
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
								flex: 1,
								minHeight: hasFanIn ? 72 : 88,
							}}
						/>
					</label>
					<div
						style={{
							color: theme.colors.textDim,
							fontSize: 10,
							textAlign: 'right',
							flexShrink: 0,
							marginTop: 2,
						}}
					>
						{localOutputPrompt.length} chars
					</div>
				</div>
			</div>

			{/* Upstream Sources — per-source output controls */}
			{hasIncomingAgentEdges && incomingAgentEdges && incomingAgentEdges.length > 0 && (
				<div
					style={{
						padding: '10px 12px',
						backgroundColor: `${CUE_COLOR}08`,
						border: `1px solid ${theme.colors.border}`,
						borderRadius: 6,
						display: 'flex',
						flexDirection: 'column',
						gap: 6,
						flexShrink: 0,
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
						<div style={{ fontSize: 11, fontWeight: 600, color: theme.colors.textMain }}>
							Upstream Sources
						</div>
						<div
							style={{
								fontSize: 10,
								color: theme.colors.textDim,
								backgroundColor: `${CUE_COLOR}15`,
								padding: '2px 8px',
								borderRadius: 10,
							}}
						>
							{incomingAgentEdges.length} source{incomingAgentEdges.length !== 1 ? 's' : ''}
						</div>
					</div>
					<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
						Control how each upstream agent's output flows through this node
					</div>

					{/* Per-source rows */}
					{incomingAgentEdges.map((edge) => {
						const varSuffix = sanitizeVarName(edge.sourceSessionName);
						const editable = !!onUpdateEdge;
						return (
							<div
								key={edge.edgeId}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 10,
									padding: '6px 8px',
									backgroundColor: theme.colors.bgMain,
									borderRadius: 4,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{/* Source name */}
								<div
									style={{
										fontSize: 11,
										fontWeight: 500,
										color: theme.colors.textMain,
										minWidth: 80,
										flex: '0 0 auto',
									}}
								>
									{edge.sourceSessionName}
								</div>

								{/* Include toggle */}
								<label
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 4,
										fontSize: 10,
										color: edge.includeUpstreamOutput
											? theme.colors.textMain
											: theme.colors.textDim,
										cursor: editable ? 'pointer' : 'default',
										opacity: editable ? 1 : 0.5,
										flex: '0 0 auto',
									}}
								>
									<input
										type="checkbox"
										checked={edge.includeUpstreamOutput}
										disabled={!editable}
										onChange={(e) => {
											onUpdateEdge!(edge.edgeId, {
												includeUpstreamOutput: e.target.checked,
											});
										}}
										style={{ accentColor: CUE_COLOR }}
									/>
									Include
								</label>

								{/* Forward toggle */}
								<label
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: 4,
										fontSize: 10,
										color: edge.forwardOutput ? theme.colors.textMain : theme.colors.textDim,
										cursor: editable ? 'pointer' : 'default',
										opacity: editable ? 1 : 0.5,
										flex: '0 0 auto',
									}}
								>
									<input
										type="checkbox"
										checked={edge.forwardOutput}
										disabled={!editable}
										onChange={(e) => {
											onUpdateEdge!(edge.edgeId, {
												forwardOutput: e.target.checked,
											});
										}}
										style={{ accentColor: CUE_COLOR }}
									/>
									Forward
								</label>

								{/* Per-source variable token chips */}
								<div
									style={{
										display: 'flex',
										gap: 4,
										marginLeft: 'auto',
										flexShrink: 0,
										alignItems: 'center',
									}}
								>
									{edge.includeUpstreamOutput && (
										<code
											style={{
												fontSize: 9,
												color: CUE_COLOR,
												backgroundColor: `${CUE_COLOR}10`,
												padding: '1px 5px',
												borderRadius: 3,
												userSelect: 'all',
											}}
										>
											{'{{'}CUE_OUTPUT_{varSuffix}
											{'}}'}
										</code>
									)}
									{edge.forwardOutput && (
										<code
											style={{
												fontSize: 9,
												color: theme.colors.textDim,
												backgroundColor: `${theme.colors.textDim}15`,
												padding: '1px 5px',
												borderRadius: 3,
												userSelect: 'all',
											}}
										>
											{'{{'}CUE_FORWARDED_{varSuffix}
											{'}}'}
										</code>
									)}
									{!edge.includeUpstreamOutput && !edge.forwardOutput && (
										<span
											style={{
												fontSize: 9,
												color: theme.colors.textDim,
												opacity: 0.6,
												fontStyle: 'italic',
											}}
										>
											trigger only
										</span>
									)}
								</div>
							</div>
						);
					})}

					{/* Combined variable hint */}
					{incomingAgentEdges.some((e) => e.includeUpstreamOutput) && (
						<div style={{ fontSize: 10, color: theme.colors.textDim, opacity: 0.7 }}>
							{'{{CUE_SOURCE_OUTPUT}}'} combines all included sources. Use per-source variables
							above for fine-grained placement.
						</div>
					)}
				</div>
			)}

			{/* Fan-in Settings — full width below prompts */}
			{(incomingAgentEdgeCount ?? 0) > 1 && (
				<div
					style={{
						padding: '10px 12px',
						backgroundColor: `${theme.colors.accent}08`,
						border: `1px solid ${theme.colors.border}`,
						borderRadius: 6,
						display: 'flex',
						flexDirection: 'column',
						gap: 8,
						flexShrink: 0,
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
						<div style={{ fontSize: 11, fontWeight: 600, color: theme.colors.textMain }}>
							Fan-in
						</div>
						<div
							style={{
								fontSize: 10,
								color: theme.colors.textDim,
								backgroundColor: `${theme.colors.accent}15`,
								padding: '2px 8px',
								borderRadius: 10,
							}}
						>
							{incomingAgentEdgeCount} agents →
						</div>
					</div>
					<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
						Waits for all upstream agents to complete before running
					</div>
					<div style={{ display: 'flex', gap: 10 }}>
						<label style={{ ...getLabelStyle(theme), flex: 1, margin: 0 }}>
							<span
								style={{
									fontSize: 10,
									color: theme.colors.textDim,
									marginBottom: 3,
									display: 'block',
								}}
							>
								Timeout (minutes)
							</span>
							<input
								type="number"
								min={1}
								value={data.fanInTimeoutMinutes ?? ''}
								placeholder="global default"
								onChange={(e) =>
									onUpdateNode(node.id, {
										fanInTimeoutMinutes: e.target.value ? Number(e.target.value) : undefined,
									} as Partial<AgentNodeData>)
								}
								style={{ ...getInputStyle(theme), width: '100%' }}
							/>
						</label>
						<div style={{ ...getLabelStyle(theme), flex: 1, margin: 0 }}>
							<span
								style={{
									fontSize: 10,
									color: theme.colors.textDim,
									marginBottom: 3,
									display: 'block',
								}}
							>
								On timeout
							</span>
							<CueSelect
								value={data.fanInTimeoutOnFail ?? ''}
								options={[
									{ value: '', label: 'Global default' },
									{ value: 'break', label: 'Wait for all' },
									{ value: 'continue', label: 'Continue with partial' },
								]}
								onChange={(v) =>
									onUpdateNode(node.id, {
										fanInTimeoutOnFail: (v || undefined) as AgentNodeData['fanInTimeoutOnFail'],
									} as Partial<AgentNodeData>)
								}
								theme={theme}
							/>
						</div>
					</div>
				</div>
			)}

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
