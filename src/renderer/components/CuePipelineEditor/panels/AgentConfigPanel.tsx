/**
 * AgentConfigPanel — Configuration panel for agent nodes in the pipeline.
 *
 * Handles input/output prompts, single-trigger vs multi-trigger modes,
 * upstream output inclusion, and pipeline membership display.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Theme } from '../../../types';
import {
	CUE_COLOR,
	type PipelineNode,
	type PipelineEdge,
	type AgentNodeData,
	type TriggerNodeData,
	type CuePipeline,
	type IncomingAgentEdgeInfo,
} from '../../../../shared/cue-pipeline-types';
import { useDebouncedCallback } from '../../../hooks/utils';
import { registerPendingEdit } from '../../../hooks/cue/pendingEditsRegistry';
import type { IncomingTriggerEdgeInfo } from './NodeConfigPanel';
import { EdgePromptRow } from './EdgePromptRow';
import { CueSelect } from './CueSelect';
import { UpstreamSourcesPanel } from './UpstreamSourcesPanel';
import { computeTransitiveUpstream } from '../utils/transitiveUpstream';
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

	const { debouncedCallback: debouncedUpdateInput, flush: flushInput } = useDebouncedCallback(
		(...args: unknown[]) => {
			const inputPrompt = args[0] as string;
			onUpdateNode(node.id, { inputPrompt } as Partial<AgentNodeData>);
		},
		300
	);

	const { debouncedCallback: debouncedUpdateOutput, flush: flushOutput } = useDebouncedCallback(
		(...args: unknown[]) => {
			const outputPrompt = args[0] as string;
			onUpdateNode(node.id, { outputPrompt } as Partial<AgentNodeData>);
		},
		300
	);

	// Flush any pending prompt writes on unmount. Combined with the `key={node.id}`
	// applied by the parent, this guarantees the user's last keystrokes commit to
	// THIS node before the component is torn down on selection change — otherwise
	// the 300ms debounce would race against React unmount and drop the edit.
	//
	// Also register with the pending-edits registry so `handleSave` can flush
	// this panel's pending writes before it reads pipelineState — clicking Save
	// within 300ms of a keystroke would otherwise persist stale/empty prompts.
	useEffect(() => {
		const unregister = registerPendingEdit(() => {
			flushInput();
			flushOutput();
		});
		return () => {
			flushInput();
			flushOutput();
			unregister();
		};
	}, [flushInput, flushOutput]);

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

	// Single pass over `pipelines` derives both values we need downstream:
	//   - `owningPipeline`: the pipeline containing THIS node by node.id.
	//     Used as the input to `computeTransitiveUpstream` below. Memoized
	//     so the transitive-walk memo's input stays referentially stable.
	//   - `agentPipelines`: every pipeline containing this AGENT (by
	//     sessionId). The same agent can appear in multiple pipelines, so
	//     this is a superset of `owningPipeline`.
	// Previously these were two separate `useMemo` calls that each scanned
	// `pipelines` independently — merging them halves the work.
	const { owningPipeline, agentPipelines } = useMemo(() => {
		let owning: CuePipeline | undefined;
		const matching: CuePipeline[] = [];
		for (const p of pipelines) {
			let ownsThisNode = false;
			let containsAgent = false;
			for (const n of p.nodes) {
				if (n.id === node.id) ownsThisNode = true;
				if (n.type === 'agent' && (n.data as AgentNodeData).sessionId === data.sessionId) {
					containsAgent = true;
				}
				if (ownsThisNode && containsAgent) break;
			}
			if (ownsThisNode && !owning) owning = p;
			if (containsAgent) matching.push(p);
		}
		return { owningPipeline: owning, agentPipelines: matching };
	}, [pipelines, node.id, data.sessionId]);

	// Forwarded upstream sources — these agents relay output through an
	// intermediate node rather than having a direct edge. The layout and
	// input-prompt hints treat direct + forwarded identically (both expose
	// per-source template variables and render the UpstreamSourcesPanel),
	// so we compute this once here and derive `hasAnyUpstream` from it.
	const forwardedUpstream = useMemo(
		() =>
			owningPipeline
				? computeTransitiveUpstream(owningPipeline, node.id).filter((r) => !r.isDirect)
				: [],
		[owningPipeline, node.id]
	);
	const hasAnyUpstream = !!hasIncomingAgentEdges || forwardedUpstream.length > 0;

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
					// if needed, keeping the cards reachable. `hasAnyUpstream` —
					// not just direct edges — because UpstreamSourcesPanel also
					// renders when only forwarded sources exist, and the layout
					// must reserve space for it in that case too.
					flex: 1,
					minHeight: hasAnyUpstream ? 100 : 0,
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
										: hasAnyUpstream
											? // Direct AND forwarded-only cases both show the upstream
												// card below, so the "use per-source variables" hint
												// applies equally — forwarded sources are reached via
												// {{CUE_FORWARDED_<NAME>}} vars listed in the card.
												'Instructions for this agent. Use per-source variables from the card below.'
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

			{/* Upstream Sources — per-source output controls. The panel self-gates
			    when there are no direct OR forwarded sources, so an agent with
			    only forwarded upstream still sees the box. We hand it the
			    pre-computed `forwardedUpstream` list so the transitive graph
			    walk runs once per render up here, not again inside the panel. */}
			<UpstreamSourcesPanel
				theme={theme}
				incomingAgentEdges={incomingAgentEdges ?? []}
				onUpdateEdge={onUpdateEdge}
				forwardedSources={forwardedUpstream}
			/>

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
