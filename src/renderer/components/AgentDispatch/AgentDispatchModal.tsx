/**
 * AgentDispatchModal
 *
 * Thin modal shell wrapping the Maestro Board work view.
 * Mirrors the SymphonyModal pattern: portal-mounted, layer-stack registered,
 * Escape-to-close, backdrop click to close.
 */

import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { KanbanBoard } from './KanbanBoard';

export interface AgentDispatchModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	projectPath?: string | null;
	sshRemoteId?: string | null;
	mode?: 'board' | 'pm-chat';
}

export function AgentDispatchModal({
	theme,
	isOpen,
	onClose,
	projectPath,
	sshRemoteId,
	mode = 'board',
}: AgentDispatchModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const title = mode === 'pm-chat' ? 'Project PM' : 'Maestro Board';

	useModalLayer(MODAL_PRIORITIES.AGENT_DISPATCH, title, () => onCloseRef.current(), {
		enabled: isOpen,
	});

	if (!isOpen) return null;

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center"
			style={{ zIndex: MODAL_PRIORITIES.AGENT_DISPATCH }}
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
					width: 'min(1100px, 95vw)',
					height: 'min(750px, 90vh)',
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-3">
						<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							{title}
						</span>
					</div>
					<button
						onClick={onClose}
						className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
						style={{ color: theme.colors.textDim }}
						aria-label="Close Maestro Board"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-hidden">
					<KanbanBoard
						theme={theme}
						projectPath={projectPath}
						sshRemoteId={sshRemoteId}
						mode={mode}
					/>
				</div>
			</div>
		</div>,
		document.body
	);
}
