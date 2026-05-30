/**
 * UpstreamSourcesPanel — per-source output controls for an agent that has
 * one or more upstream sources (direct or forwarded).
 *
 * Direct and forwarded sources render as uniform rows in one table so users
 * see every data stream arriving at this agent without having to navigate
 * upstream. Direct rows carry Include/Forward toggles bound to the direct
 * edge; forwarded rows are informational — they expose the available
 * `{{CUE_FORWARDED_<NAME>}}` variable, and if the user wants to stop the
 * forwarding they do so on the upstream relay agent itself.
 */

import type { Theme } from '../../../types';
import {
	CUE_COLOR,
	sanitizeVarName,
	type CuePipeline,
	type IncomingAgentEdgeInfo,
	type PipelineEdge,
} from '../../../../shared/cue-pipeline-types';
import { computeTransitiveUpstream, type TransitiveUpstream } from '../utils/transitiveUpstream';

interface UpstreamSourcesPanelProps {
	theme: Theme;
	incomingAgentEdges: IncomingAgentEdgeInfo[];
	onUpdateEdge?: (edgeId: string, updates: Partial<PipelineEdge>) => void;
	/**
	 * Pre-filtered list of forwarded (transitive) upstream sources. When
	 * provided, the panel uses it directly and skips its own transitive
	 * computation. This lets callers (AgentConfigPanel) share one
	 * `computeTransitiveUpstream` result across the panel and any sibling
	 * logic that also needs `hasAnyUpstream`, instead of running the graph
	 * walk twice per render. Omit for isolated storybook/test mounts — the
	 * panel falls back to computing from `pipeline` + `targetNodeId` below.
	 */
	forwardedSources?: TransitiveUpstream[];
	/** Full pipeline graph for forwarded-source discovery when
	 *  `forwardedSources` is not supplied. */
	pipeline?: CuePipeline;
	/** Target node id — the agent whose upstream is being configured.
	 *  Required together with `pipeline` for the fallback computation. */
	targetNodeId?: string;
}

export function UpstreamSourcesPanel({
	theme,
	incomingAgentEdges,
	onUpdateEdge,
	forwardedSources: forwardedSourcesProp,
	pipeline,
	targetNodeId,
}: UpstreamSourcesPanelProps) {
	const editable = !!onUpdateEdge;
	// Prefer the pre-computed list from the caller. Only recompute when
	// neither the list nor a pipeline is available (shouldn't happen in
	// production paths; kept for storybook/test scaffolding that passes
	// just a pipeline).
	const forwardedSources =
		forwardedSourcesProp ??
		(pipeline && targetNodeId
			? computeTransitiveUpstream(pipeline, targetNodeId).filter((r) => !r.isDirect)
			: []);

	if (incomingAgentEdges.length === 0 && forwardedSources.length === 0) return null;

	const totalCount = incomingAgentEdges.length + forwardedSources.length;

	return (
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
					{totalCount} source{totalCount !== 1 ? 's' : ''}
				</div>
			</div>
			<div style={{ color: theme.colors.textDim, fontSize: 10 }}>
				Control how each upstream agent's output flows through this node. Reference the variables
				below anywhere in the prompt to position them.
			</div>

			{/* Direct edges — editable Include / Forward */}
			{incomingAgentEdges.map((edge) => {
				const varSuffix = sanitizeVarName(edge.sourceSessionName);
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

						<label
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: 4,
								fontSize: 10,
								color: edge.includeUpstreamOutput ? theme.colors.textMain : theme.colors.textDim,
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

			{/* Forwarded sources — same row shape, informational (no edge to toggle at this node) */}
			{forwardedSources.map((row) => {
				const varSuffix = sanitizeVarName(row.source);
				const relayLabel = row.path.slice(1).join(' → ');
				return (
					<div
						key={`forwarded-${row.sourceNodeId}`}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: 10,
							padding: '6px 8px',
							backgroundColor: theme.colors.bgMain,
							borderRadius: 4,
							border: `1px dashed ${theme.colors.border}`,
						}}
					>
						<div
							style={{
								display: 'flex',
								flexDirection: 'column',
								minWidth: 80,
								flex: '0 0 auto',
								gap: 1,
							}}
						>
							<div style={{ fontSize: 11, fontWeight: 500, color: theme.colors.textMain }}>
								{row.source}
							</div>
							<div style={{ fontSize: 9, color: theme.colors.textDim }}>via {relayLabel}</div>
						</div>

						<div
							style={{
								fontSize: 10,
								color: theme.colors.textDim,
								fontStyle: 'italic',
								flex: '0 0 auto',
							}}
						>
							forwarded
						</div>

						<div
							style={{
								display: 'flex',
								gap: 4,
								marginLeft: 'auto',
								flexShrink: 0,
								alignItems: 'center',
							}}
						>
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
						</div>
					</div>
				);
			})}

			{incomingAgentEdges.some((e) => e.includeUpstreamOutput) && (
				<div style={{ fontSize: 10, color: theme.colors.textDim, opacity: 0.7 }}>
					{'{{CUE_SOURCE_OUTPUT}}'} combines all included direct sources.
				</div>
			)}
		</div>
	);
}
