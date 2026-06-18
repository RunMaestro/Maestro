/**
 * EdgeConfigPanel — Bottom panel for configuring selected pipeline edges.
 *
 * Provides mode selection (pass/debate/autorun) and mode-specific settings.
 * All changes update immediately.
 */

import React from 'react';
import { ArrowRight, MessageCircle, FileText, Trash2 } from 'lucide-react';
import type { Theme } from '../../../types';
import type { PipelineEdge, EdgeMode, PipelineNode } from '../../../../shared/cue-pipeline-types';

interface EdgeConfigPanelProps {
	selectedEdge: PipelineEdge | null;
	theme: Theme;
	sourceNode: PipelineNode | null;
	targetNode: PipelineNode | null;
	pipelineColor: string;
	onUpdateEdge: (edgeId: string, updates: Partial<PipelineEdge>) => void;
	onDeleteEdge: (edgeId: string) => void;
}

function getNodeLabel(node: PipelineNode | null): string {
	if (!node) return '?';
	if (node.type === 'trigger') {
		return (node.data as { label: string }).label;
	}
	return (node.data as { sessionName: string }).sessionName;
}

const MODES: Array<{
	mode: EdgeMode;
	label: string;
	icon: typeof ArrowRight;
	description: string;
	comingSoon?: boolean;
}> = [
	{
		mode: 'pass',
		label: 'Pass',
		icon: ArrowRight,
		description: 'Data passes through to next agent',
	},
	{
		mode: 'debate',
		label: 'Debate',
		icon: MessageCircle,
		description: 'Multiple agents debate before passing result',
		comingSoon: true,
	},
	{
		mode: 'autorun',
		label: 'Auto Run',
		icon: FileText,
		description: 'Agent creates auto-run documents for next agent',
		comingSoon: true,
	},
];

function EdgeConfigPanelInner({
	selectedEdge,
	theme,
	sourceNode,
	targetNode,
	pipelineColor,
	onUpdateEdge,
	onDeleteEdge,
}: EdgeConfigPanelProps) {
	if (!selectedEdge) return null;

	const currentMode = selectedEdge.mode;

	return (
		<div
			style={{
				position: 'absolute',
				bottom: 0,
				left: 220,
				right: 240,
				height: 200,
				backgroundColor: theme.colors.bgMain,
				borderTop: `1px solid ${theme.colors.border}`,
				borderLeft: `1px solid ${theme.colors.border}`,
				borderRight: `1px solid ${theme.colors.border}`,
				borderRadius: '8px 8px 0 0',
				boxShadow: '0 -4px 16px rgba(0,0,0,0.3)',
				display: 'flex',
				flexDirection: 'column',
				zIndex: 10,
				animation: 'edgeSlideUp 0.15s ease-out',
			}}
		>
			<style>{`
				@keyframes edgeSlideUp {
					from { transform: translateY(100%); }
					to { transform: translateY(0); }
				}
			`}</style>

			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '8px 16px',
					borderBottom: `1px solid ${theme.colors.bgActivity}`,
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<span style={{ color: theme.colors.textMain, fontSize: 13, fontWeight: 600 }}>
						Connection Settings
					</span>
					<span style={{ color: theme.colors.textDim, fontSize: 11 }}>
						{getNodeLabel(sourceNode)}
						<span style={{ margin: '0 4px', color: theme.colors.textDim }}>&rarr;</span>
						{getNodeLabel(targetNode)}
					</span>
				</div>
				<button
					onClick={() => onDeleteEdge(selectedEdge.id)}
					style={{
						display: 'flex',
						alignItems: 'center',
						padding: 4,
						color: theme.colors.textDim,
						backgroundColor: 'transparent',
						border: 'none',
						borderRadius: 4,
						cursor: 'pointer',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.color = theme.colors.error)}
					onMouseLeave={(e) => (e.currentTarget.style.color = theme.colors.textDim)}
					title="Delete connection"
				>
					<Trash2 size={14} />
				</button>
			</div>

			{/* Content */}
			<div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
				{/* Mode selector */}
				<div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
					{MODES.map(({ mode, label, icon: Icon, comingSoon }) => {
						const isActive = currentMode === mode;
						return (
							<button
								key={mode}
								onClick={() => {
									if (comingSoon) return;
									const updates: Partial<PipelineEdge> = { mode };
									if (mode === 'debate' && !selectedEdge.debateConfig) {
										updates.debateConfig = { maxRounds: 3, timeoutPerRound: 10 };
									}
									onUpdateEdge(selectedEdge.id, updates);
								}}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: 6,
									padding: '6px 14px',
									fontSize: 12,
									fontWeight: 500,
									color: isActive ? pipelineColor : theme.colors.textDim,
									backgroundColor: isActive ? `${pipelineColor}15` : 'transparent',
									border: `1px solid ${isActive ? pipelineColor : theme.colors.border}`,
									borderRadius: 6,
									cursor: comingSoon ? 'default' : 'pointer',
									transition: 'all 0.15s',
									opacity: comingSoon ? 0.5 : 1,
								}}
								title={comingSoon ? 'Coming soon' : undefined}
							>
								<Icon size={13} />
								{label}
								{comingSoon && (
									<span style={{ fontSize: 9, color: theme.colors.textDim }}>(Soon)</span>
								)}
							</button>
						);
					})}
				</div>

				{/* Mode description */}
				<div style={{ color: theme.colors.textDim, fontSize: 11, marginBottom: 12 }}>
					{MODES.find((m) => m.mode === currentMode)?.description}
				</div>

				{/* Debate settings */}
				{currentMode === 'debate' && (
					<div style={{ display: 'flex', gap: 16 }}>
						<label style={{ color: theme.colors.textDim, fontSize: 11, fontWeight: 500 }}>
							Max Rounds
							<input
								type="number"
								min={1}
								max={20}
								value={selectedEdge.debateConfig?.maxRounds ?? 3}
								onChange={(e) => {
									const maxRounds = Math.min(20, Math.max(1, parseInt(e.target.value) || 3));
									onUpdateEdge(selectedEdge.id, {
										debateConfig: {
											...selectedEdge.debateConfig!,
											maxRounds,
										},
									});
								}}
								style={{
									display: 'block',
									marginTop: 4,
									width: 80,
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
									borderRadius: 4,
									color: theme.colors.textMain,
									padding: '4px 8px',
									fontSize: 12,
									outline: 'none',
								}}
							/>
						</label>
						<label style={{ color: theme.colors.textDim, fontSize: 11, fontWeight: 500 }}>
							Timeout per Round (min)
							<input
								type="number"
								min={1}
								max={120}
								value={selectedEdge.debateConfig?.timeoutPerRound ?? 10}
								onChange={(e) => {
									const timeoutPerRound = Math.min(
										120,
										Math.max(1, parseInt(e.target.value) || 10)
									);
									onUpdateEdge(selectedEdge.id, {
										debateConfig: {
											...selectedEdge.debateConfig!,
											timeoutPerRound,
										},
									});
								}}
								style={{
									display: 'block',
									marginTop: 4,
									width: 80,
									backgroundColor: theme.colors.bgActivity,
									border: `1px solid ${theme.colors.border}`,
									borderRadius: 4,
									color: theme.colors.textMain,
									padding: '4px 8px',
									fontSize: 12,
									outline: 'none',
								}}
							/>
						</label>
					</div>
				)}

				{/* Auto Run explanation */}
				{currentMode === 'autorun' && (
					<div style={{ color: theme.colors.textDim, fontSize: 12, fontStyle: 'italic' }}>
						The source agent will produce auto-run documents that the target agent will execute
						sequentially.
					</div>
				)}
			</div>
		</div>
	);
}

// Phase 14B — memoized so the panel does not re-render on unrelated canvas ticks.
export const EdgeConfigPanel = React.memo(EdgeConfigPanelInner);
