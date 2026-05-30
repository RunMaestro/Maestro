import React, { RefObject } from 'react';
import { ChevronLeft, Star, Edit3, Play, X } from 'lucide-react';
import { GhostIconButton } from '../../ui/GhostIconButton';
import type { Theme } from '../../../types';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';
import { formatRelativeTime } from '../../../utils/formatters';

interface SessionDetailHeaderProps {
	viewingSession: AgentSession;
	totalMessages: number;
	isStarred: boolean;
	renamingSessionId: string | null;
	renameValue: string;
	renameInputRef: RefObject<HTMLInputElement>;
	theme: Theme;
	onClearViewingSession: () => void;
	onToggleStar: (sessionId: string, e: React.MouseEvent) => void;
	onResume: () => void;
	onClose: () => void;
	onRenameChange: (value: string) => void;
	onRenameKeyDown: React.KeyboardEventHandler<HTMLInputElement>;
	onRenameBlur: () => void;
	onStartRenameNamed: (e: React.MouseEvent) => void;
	onStartRenameUnnamed: (e: React.MouseEvent) => void;
}

export const SessionDetailHeader = React.memo(function SessionDetailHeader({
	viewingSession,
	totalMessages,
	isStarred,
	renamingSessionId,
	renameValue,
	renameInputRef,
	theme,
	onClearViewingSession,
	onToggleStar,
	onResume,
	onClose,
	onRenameChange,
	onRenameKeyDown,
	onRenameBlur,
	onStartRenameNamed,
	onStartRenameUnnamed,
}: SessionDetailHeaderProps) {
	const isRenaming = renamingSessionId === viewingSession.sessionId;

	return (
		<>
			<div className="flex items-center gap-4">
				<GhostIconButton
					onClick={onClearViewingSession}
					padding="p-1.5"
					color={theme.colors.textDim}
					ariaLabel="Go back"
				>
					<ChevronLeft className="w-5 h-5" />
				</GhostIconButton>
				<GhostIconButton
					onClick={(e) => onToggleStar(viewingSession.sessionId, e)}
					padding="p-1.5"
					title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
				>
					<Star
						className="w-5 h-5"
						style={{
							color: isStarred ? theme.colors.warning : theme.colors.textDim,
							fill: isStarred ? theme.colors.warning : 'transparent',
						}}
					/>
				</GhostIconButton>
				<div className="flex flex-col min-w-0">
					{isRenaming ? (
						<div className="flex items-center gap-1.5">
							<input
								ref={renameInputRef}
								type="text"
								value={renameValue}
								onChange={(e) => onRenameChange(e.target.value)}
								onKeyDown={onRenameKeyDown}
								onBlur={onRenameBlur}
								placeholder="Enter session name..."
								className="bg-transparent outline-none text-sm font-semibold px-2 py-0.5 rounded border"
								style={{
									color: theme.colors.accent,
									borderColor: theme.colors.accent,
									backgroundColor: theme.colors.bgActivity,
								}}
							/>
						</div>
					) : viewingSession.sessionName ? (
						<div className="flex items-center gap-1.5">
							<span
								className="text-sm font-semibold truncate max-w-md"
								style={{ color: theme.colors.accent }}
							>
								{viewingSession.sessionName}
							</span>
							<GhostIconButton onClick={onStartRenameNamed} padding="p-0.5" title="Rename session">
								<Edit3 className="w-3 h-3" style={{ color: theme.colors.accent }} />
							</GhostIconButton>
						</div>
					) : (
						<div className="flex items-center gap-1.5">
							<span
								className="text-sm font-mono font-medium truncate max-w-md"
								style={{ color: theme.colors.textMain }}
							>
								{viewingSession.sessionId.toUpperCase()}
							</span>
							<GhostIconButton
								onClick={onStartRenameUnnamed}
								padding="p-0.5"
								title="Add session name"
							>
								<Edit3 className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							</GhostIconButton>
						</div>
					)}
					{viewingSession.sessionName && (
						<div
							className="text-xs font-mono truncate max-w-md"
							style={{ color: theme.colors.textDim }}
						>
							{viewingSession.sessionId.toUpperCase()}
						</div>
					)}
					<div className="text-xs flex items-center gap-1" style={{ color: theme.colors.textDim }}>
						<span>{totalMessages} messages</span>
						<span>•</span>
						<span
							className="relative group cursor-default"
							title={new Date(viewingSession.modifiedAt).toLocaleString()}
						>
							{formatRelativeTime(viewingSession.modifiedAt)}
							<span
								className="absolute left-0 top-0 opacity-0 group-hover:opacity-100 transition-opacity px-1 rounded whitespace-nowrap"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
								}}
							>
								{new Date(viewingSession.modifiedAt).toLocaleString()}
							</span>
						</span>
					</div>
				</div>
			</div>
			<div className="flex items-center gap-2">
				<button
					onClick={onResume}
					className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					<Play className="w-4 h-4" />
					Resume
				</button>
				<button
					onClick={onClose}
					className="p-2 rounded hover:bg-white/5 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-4 h-4" />
				</button>
			</div>
		</>
	);
});
