import React from 'react';
import { List, Plus, X } from 'lucide-react';
import type { Theme } from '../../../types';

interface SessionListHeaderProps {
	agentId: string;
	sessionName: string | undefined;
	activeAgentSessionId: string | null;
	theme: Theme;
	onNewSession: () => void;
	onClose: () => void;
}

export const SessionListHeader = React.memo(function SessionListHeader({
	agentId,
	sessionName,
	activeAgentSessionId,
	theme,
	onNewSession,
	onClose,
}: SessionListHeaderProps) {
	return (
		<>
			<div className="flex items-center gap-4">
				<List className="w-5 h-5" style={{ color: theme.colors.textDim }} />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{agentId === 'claude-code' ? 'Claude' : 'Agent'} Sessions for {sessionName || 'Agent'}
				</span>
				{activeAgentSessionId && (
					<span
						className="text-xs px-2 py-0.5 rounded-full"
						style={{
							backgroundColor: theme.colors.accent + '20',
							color: theme.colors.accent,
						}}
					>
						Active: {activeAgentSessionId.slice(0, 8)}...
					</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				<button
					onClick={onNewSession}
					className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
					style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				>
					<Plus className="w-4 h-4" />
					New Session
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
