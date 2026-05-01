/**
 * ConversationalPrdModal
 *
 * Thin modal shell for the Conversational PRD Planner.
 * Mirrors the AgentDispatchModal pattern: portal-mounted, layer-stack registered,
 * Escape-to-close, backdrop click to close.
 *
 * Lists existing PRD sessions and provides a "New Session" entry point.
 * Full chat UX is a follow-up iteration (#415).
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileText, Plus, Loader2 } from 'lucide-react';
import type { Theme } from '../../types';
import type { ConversationalPrdSession } from '../../../shared/conversational-prd-types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

export interface ConversationalPrdModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
}

export function ConversationalPrdModal({ theme, isOpen, onClose }: ConversationalPrdModalProps) {
	const [sessions, setSessions] = useState<ConversationalPrdSession[]>([]);
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useModalLayer(MODAL_PRIORITIES.CONVERSATIONAL_PRD, 'Conversational PRD', onClose, {
		enabled: isOpen,
	});

	useEffect(() => {
		if (!isOpen) return;

		setLoading(true);
		setError(null);

		window.maestro.conversationalPrd
			.listSessions()
			.then((result) => {
				if (result.success) {
					setSessions(result.data);
				} else {
					setError(result.error);
				}
			})
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : 'Failed to load sessions');
			})
			.finally(() => {
				setLoading(false);
			});
	}, [isOpen]);

	const handleNewSession = async () => {
		setCreating(true);
		setError(null);
		try {
			const createResult = await window.maestro.conversationalPrd.createSession({
				projectPath: '',
				gitPath: '',
			});
			if (!createResult.success) {
				setError(createResult.error);
				return;
			}
			// Refresh list
			const listResult = await window.maestro.conversationalPrd.listSessions();
			if (listResult.success) {
				setSessions(listResult.data);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to create session');
		} finally {
			setCreating(false);
		}
	};

	if (!isOpen) return null;

	return createPortal(
		<div
			className="fixed inset-0 flex items-center justify-center"
			style={{ zIndex: MODAL_PRIORITIES.CONVERSATIONAL_PRD }}
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
					width: 'min(700px, 95vw)',
					height: 'min(520px, 85vh)',
					backgroundColor: theme.colors.bgMain,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				{/* Header */}
				<div
					className="flex items-center justify-between px-5 py-3 border-b flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<FileText className="w-4 h-4" style={{ color: theme.colors.accent }} />
						<span className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
							Conversational PRD
						</span>
					</div>
					<button
						onClick={onClose}
						className="p-1.5 rounded-lg transition-colors hover:bg-white/10"
						style={{ color: theme.colors.textDim }}
						aria-label="Close Conversational PRD"
					>
						<X className="w-4 h-4" />
					</button>
				</div>

				{/* Toolbar */}
				<div
					className="flex items-center justify-between px-5 py-2 border-b flex-shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{sessions.length} session{sessions.length !== 1 ? 's' : ''}
					</span>
					<button
						onClick={handleNewSession}
						disabled={creating}
						className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors"
						style={{
							backgroundColor: theme.colors.accent,
							color: '#fff',
							opacity: creating ? 0.6 : 1,
						}}
					>
						{creating ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
						New Session
					</button>
				</div>

				{/* Content */}
				<div className="flex-1 overflow-y-auto px-5 py-4">
					{error && (
						<div
							className="mb-3 px-3 py-2 rounded-lg text-xs"
							style={{
								backgroundColor: theme.colors.error + '20',
								color: theme.colors.error,
								border: `1px solid ${theme.colors.error}40`,
							}}
						>
							{error}
						</div>
					)}

					{loading ? (
						<div className="flex items-center justify-center h-24 gap-2">
							<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								Loading sessions…
							</span>
						</div>
					) : sessions.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-32 gap-2">
							<FileText className="w-8 h-8" style={{ color: theme.colors.textDim }} />
							<span className="text-sm" style={{ color: theme.colors.textDim }}>
								No PRD sessions yet. Create one to get started.
							</span>
						</div>
					) : (
						<div className="flex flex-col gap-2">
							{sessions.map((session) => (
								<div
									key={session.conversationId}
									className="flex items-center gap-3 px-3 py-2.5 rounded-lg"
									style={{
										backgroundColor: theme.colors.bgActivity,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									<FileText
										className="w-4 h-4 flex-shrink-0"
										style={{ color: theme.colors.accent }}
									/>
									<div className="flex-1 min-w-0">
										<div
											className="text-sm font-medium truncate"
											style={{ color: theme.colors.textMain }}
										>
											{session.conversationId}
										</div>
										{session.metadata.projectPath && (
											<div
												className="text-xs truncate mt-0.5"
												style={{ color: theme.colors.textDim }}
											>
												{session.metadata.projectPath}
											</div>
										)}
									</div>
									<div className="text-xs flex-shrink-0" style={{ color: theme.colors.textDim }}>
										{new Date(session.metadata.startedAt).toLocaleDateString()}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>,
		document.body
	);
}
