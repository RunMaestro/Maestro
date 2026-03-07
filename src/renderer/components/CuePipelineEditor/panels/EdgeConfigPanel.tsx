/**
 * EdgeConfigPanel — Bottom panel for configuring selected pipeline edges.
 *
 * Provides mode selection (pass/debate/autorun) and mode-specific settings.
 * All changes update immediately.
 */

import { ArrowRight, MessageCircle, FileText, Trash2 } from 'lucide-react';
import type { PipelineEdge, EdgeMode, PipelineNode } from '../../../../shared/cue-pipeline-types';

interface EdgeConfigPanelProps {
	selectedEdge: PipelineEdge | null;
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
	},
	{
		mode: 'autorun',
		label: 'Auto Run',
		icon: FileText,
		description: 'Agent creates auto-run documents for next agent',
	},
];

export function EdgeConfigPanel({
	selectedEdge,
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
				left: 0,
				right: 0,
				height: 200,
				backgroundColor: '#1a1a2e',
				borderTop: '1px solid #333',
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
					borderBottom: '1px solid #2a2a3e',
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
					<span style={{ color: '#e4e4e7', fontSize: 13, fontWeight: 600 }}>
						Connection Settings
					</span>
					<span style={{ color: '#9ca3af', fontSize: 11 }}>
						{getNodeLabel(sourceNode)}
						<span style={{ margin: '0 4px', color: '#6b7280' }}>&rarr;</span>
						{getNodeLabel(targetNode)}
					</span>
				</div>
				<button
					onClick={() => onDeleteEdge(selectedEdge.id)}
					style={{
						display: 'flex',
						alignItems: 'center',
						padding: 4,
						color: '#6b7280',
						backgroundColor: 'transparent',
						border: 'none',
						borderRadius: 4,
						cursor: 'pointer',
					}}
					onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
					onMouseLeave={(e) => (e.currentTarget.style.color = '#6b7280')}
					title="Delete connection"
				>
					<Trash2 size={14} />
				</button>
			</div>

			{/* Content */}
			<div style={{ flex: 1, overflow: 'auto', padding: '12px 16px' }}>
				{/* Mode selector */}
				<div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
					{MODES.map(({ mode, label, icon: Icon }) => {
						const isActive = currentMode === mode;
						return (
							<button
								key={mode}
								onClick={() => {
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
									color: isActive ? pipelineColor : '#9ca3af',
									backgroundColor: isActive ? `${pipelineColor}15` : 'transparent',
									border: `1px solid ${isActive ? pipelineColor : '#444'}`,
									borderRadius: 6,
									cursor: 'pointer',
									transition: 'all 0.15s',
								}}
							>
								<Icon size={13} />
								{label}
							</button>
						);
					})}
				</div>

				{/* Mode description */}
				<div style={{ color: '#6b7280', fontSize: 11, marginBottom: 12 }}>
					{MODES.find((m) => m.mode === currentMode)?.description}
				</div>

				{/* Debate settings */}
				{currentMode === 'debate' && (
					<div style={{ display: 'flex', gap: 16 }}>
						<label style={{ color: '#9ca3af', fontSize: 11, fontWeight: 500 }}>
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
									backgroundColor: '#2a2a3e',
									border: '1px solid #444',
									borderRadius: 4,
									color: '#e4e4e7',
									padding: '4px 8px',
									fontSize: 12,
									outline: 'none',
								}}
							/>
						</label>
						<label style={{ color: '#9ca3af', fontSize: 11, fontWeight: 500 }}>
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
									backgroundColor: '#2a2a3e',
									border: '1px solid #444',
									borderRadius: 4,
									color: '#e4e4e7',
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
					<div style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>
						The source agent will produce auto-run documents that the target agent will execute
						sequentially.
					</div>
				)}
			</div>
		</div>
	);
}
