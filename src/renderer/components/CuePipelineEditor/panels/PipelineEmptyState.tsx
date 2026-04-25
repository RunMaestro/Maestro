/**
 * PipelineEmptyState — Phase 14B extraction from PipelineCanvas.
 *
 * Shown when there are zero nodes on the canvas. Two shapes depending on
 * whether any pipelines exist:
 *  - `pipelineCount === 0`: full-CTA mode ("Create your first pipeline").
 *  - otherwise: instructional ("drag a trigger / agent") with pointer events
 *    disabled so the user can still click onto the canvas behind it.
 *
 * React.memo'd so it doesn't re-render on every drag tick.
 */

import React, { useRef, useEffect } from 'react';
import { Zap, Plus } from 'lucide-react';
import type { Theme } from '../../../types';

const DRAWER_OPEN_DELAY_MS = 50;

export interface PipelineEmptyStateProps {
	pipelineCount: number;
	nodeCount: number;
	theme: Theme;
	createPipeline: () => void;
	setTriggerDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
	setAgentDrawerOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

function PipelineEmptyStateInner({
	pipelineCount,
	nodeCount,
	theme,
	createPipeline,
	setTriggerDrawerOpen,
	setAgentDrawerOpen,
}: PipelineEmptyStateProps) {
	const drawerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (drawerTimerRef.current !== null) clearTimeout(drawerTimerRef.current);
		};
	}, []);

	if (nodeCount !== 0) return null;
	return (
		<div
			className="absolute inset-0 flex items-center justify-center"
			style={{
				zIndex: 5,
				pointerEvents: pipelineCount === 0 ? 'auto' : 'none',
			}}
		>
			{pipelineCount === 0 ? (
				<div className="flex flex-col items-center gap-4 text-center px-8">
					<Zap size={28} style={{ color: theme.colors.textDim, opacity: 0.5 }} />
					<span className="text-sm" style={{ color: theme.colors.textDim }}>
						Build event-driven automations by connecting triggers to agents
					</span>
					<button
						onClick={() => {
							createPipeline();
							if (drawerTimerRef.current !== null) clearTimeout(drawerTimerRef.current);
							drawerTimerRef.current = setTimeout(() => {
								setTriggerDrawerOpen(true);
								setAgentDrawerOpen(true);
							}, DRAWER_OPEN_DELAY_MS);
						}}
						className="flex items-center gap-2 px-4 py-2 rounded text-sm font-medium"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.bgMain,
							cursor: 'pointer',
							transition: 'opacity 0.15s',
						}}
						onMouseEnter={(e) => {
							e.currentTarget.style.opacity = '0.85';
						}}
						onMouseLeave={(e) => {
							e.currentTarget.style.opacity = '1';
						}}
					>
						<Plus size={14} />
						Create your first pipeline
					</button>
				</div>
			) : (
				<div className="flex flex-col items-center gap-3 text-center px-8">
					<div className="flex items-center gap-6" style={{ color: theme.colors.textDim }}>
						<div className="flex flex-col items-center gap-1">
							<span style={{ fontSize: 20 }}>←</span>
							<span className="text-xs">Triggers</span>
						</div>
						<div className="flex flex-col items-center gap-2 max-w-xs">
							<Zap size={24} style={{ color: theme.colors.textDim, opacity: 0.5 }} />
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								Drag a trigger from the left drawer and an agent from the right drawer
							</span>
						</div>
						<div className="flex flex-col items-center gap-1">
							<span style={{ fontSize: 20 }}>→</span>
							<span className="text-xs">Agents</span>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export const PipelineEmptyState = React.memo(PipelineEmptyStateInner);
