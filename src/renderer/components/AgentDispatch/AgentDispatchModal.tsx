/**
 * AgentDispatchModal
 *
 * Thin modal shell wrapping the Agent Dispatch views (Fleet + Kanban).
 * Mirrors the SymphonyModal pattern: portal-mounted, layer-stack registered,
 * Escape-to-close, backdrop click to close.
 */

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Server, LayoutDashboard } from 'lucide-react';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { FleetView } from './FleetView';
import { KanbanBoard } from './KanbanBoard';

export interface AgentDispatchModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
}

type Tab = 'fleet' | 'kanban';

export function AgentDispatchModal({ theme, isOpen, onClose }: AgentDispatchModalProps) {
	const [activeTab, setActiveTab] = useState<Tab>('kanban');

	useModalLayer(MODAL_PRIORITIES.AGENT_DISPATCH, 'Agent Dispatch', onClose, {
		enabled: isOpen,
	});

	if (!isOpen) return null;

	const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: 'kanban', label: 'Work Board', icon: <LayoutDashboard className="w-4 h-4" /> },
		{ id: 'fleet', label: 'Fleet', icon: <Server className="w-4 h-4" /> },
	];

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
							Agent Dispatch
						</span>
						{/* Tabs */}
						<div
							className="flex items-center gap-1 rounded-lg p-0.5"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							{tabs.map((tab) => (
								<button
									key={tab.id}
									onClick={() => setActiveTab(tab.id)}
									className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors"
									style={{
										backgroundColor: activeTab === tab.id ? theme.colors.bgMain : 'transparent',
										color: activeTab === tab.id ? theme.colors.textMain : theme.colors.textDim,
									}}
								>
									{tab.icon}
									{tab.label}
								</button>
							))}
						</div>
					</div>
					<button
						onClick={onClose}
						className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
						style={{ color: theme.colors.textDim }}
						aria-label="Close Agent Dispatch"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-hidden">
					{activeTab === 'kanban' && <KanbanBoard theme={theme} />}
					{activeTab === 'fleet' && <FleetView theme={theme} />}
				</div>
			</div>
		</div>,
		document.body
	);
}
