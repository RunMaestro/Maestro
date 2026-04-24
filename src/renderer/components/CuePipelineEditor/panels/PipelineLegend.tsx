/**
 * PipelineLegend — Phase 14B extraction from PipelineCanvas.
 *
 * Renders the clickable pipeline color swatches overlay shown in All Pipelines
 * view. Pure presentational, wrapped in React.memo so it only re-renders when
 * `pipelines` / `selectedPipelineId` / `theme` change — previously re-rendered
 * on every node drag because it lived inline in PipelineCanvas.
 */

import React from 'react';
import type { Theme } from '../../../types';
import type { CuePipeline } from '../../../../shared/cue-pipeline-types';

export interface PipelineLegendProps {
	pipelines: CuePipeline[];
	selectedPipelineId: string | null;
	selectPipeline: (id: string | null) => void;
	theme: Theme;
}

function PipelineLegendInner({
	pipelines,
	selectedPipelineId,
	selectPipeline,
	theme,
}: PipelineLegendProps) {
	if (selectedPipelineId !== null || pipelines.length === 0) return null;
	return (
		<div
			style={{
				position: 'absolute',
				top: 8,
				left: '50%',
				transform: 'translateX(-50%)',
				zIndex: 10,
				display: 'flex',
				alignItems: 'center',
				gap: 12,
				padding: '6px 14px',
				backgroundColor: `${theme.colors.bgActivity}f5`,
				border: `1px solid ${theme.colors.border}`,
				borderRadius: 6,
			}}
		>
			{pipelines.map((p) => (
				<button
					key={p.id}
					onClick={() => selectPipeline(p.id)}
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: 6,
						fontSize: 11,
						color: theme.colors.textMain,
						backgroundColor: 'transparent',
						border: 'none',
						cursor: 'pointer',
						padding: '2px 4px',
						borderRadius: 4,
						transition: 'background-color 0.15s',
					}}
					onMouseEnter={(e) => {
						e.currentTarget.style.backgroundColor = `${theme.colors.accent}15`;
					}}
					onMouseLeave={(e) => {
						e.currentTarget.style.backgroundColor = 'transparent';
					}}
					title={`Switch to ${p.name}`}
				>
					<span
						style={{
							width: 10,
							height: 10,
							borderRadius: '50%',
							backgroundColor: p.color,
							flexShrink: 0,
							border: '1px solid rgba(255,255,255,0.15)',
						}}
					/>
					<span style={{ fontWeight: 500 }}>{p.name}</span>
					<span style={{ color: theme.colors.textDim, fontSize: 10 }}>({p.nodes.length})</span>
				</button>
			))}
		</div>
	);
}

export const PipelineLegend = React.memo(PipelineLegendInner);
