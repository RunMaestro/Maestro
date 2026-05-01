/**
 * PlanningPipelineModal
 *
 * Thin modal shell wrapping the Planning Pipeline dashboard.
 * Mirrors the SymphonyModal pattern: portal-mounted, layer-stack registered,
 * Escape-to-close, backdrop click to close.
 */

import { createPortal } from 'react-dom';
import { useRef } from 'react';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { PipelineDashboard } from './Dashboard';

export interface PlanningPipelineModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
}

export function PlanningPipelineModal({ theme, isOpen, onClose }: PlanningPipelineModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useModalLayer(
		MODAL_PRIORITIES.PLANNING_PIPELINE,
		'Planning Pipeline',
		() => onCloseRef.current(),
		{
			enabled: isOpen,
		}
	);

	if (!isOpen) return null;

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center"
			style={{ zIndex: MODAL_PRIORITIES.PLANNING_PIPELINE }}
		>
			{/* Backdrop */}
			<div
				className="absolute inset-0"
				style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
				onClick={onClose}
			/>

			{/* Modal panel */}
			<div
				className="relative flex flex-col rounded-xl shadow-2xl overflow-hidden"
				style={{
					width: 'min(1200px, 95vw)',
					height: 'min(700px, 90vh)',
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
						Planning Pipeline
					</span>
					<button
						onClick={onClose}
						className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
						style={{ color: theme.colors.textDim }}
						aria-label="Close Planning Pipeline"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-auto">
					<PipelineDashboard theme={theme} />
				</div>
			</div>
		</div>,
		document.body
	);
}
