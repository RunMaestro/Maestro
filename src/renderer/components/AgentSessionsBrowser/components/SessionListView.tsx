import React, { type RefObject } from 'react';
import { List } from 'lucide-react';
import { Spinner } from '../../ui/Spinner';
import { EmptyStatePlaceholder } from '../../ui/EmptyStatePlaceholder';
import { SessionListItem, type SearchResultInfo } from '../../SessionListItem';
import type { Theme } from '../../../types';
import type { AgentSession } from '../../../hooks/agent/useSessionViewer';
import type { SearchMode } from '../types';

interface SessionListViewProps {
	loading: boolean;
	sessions: AgentSession[];
	filteredSessions: AgentSession[];
	selectedIndex: number;
	starredSessions: Set<string>;
	activeAgentSessionId: string | null;
	renamingSessionId: string | null;
	renameValue: string;
	searchMode: SearchMode;
	search: string;
	isLoadingMoreSessions: boolean;
	hasMoreSessions: boolean;
	totalSessionCount: number;
	agentId: string;
	theme: Theme;
	sessionsContainerRef: RefObject<HTMLDivElement>;
	selectedItemRef: RefObject<HTMLButtonElement | HTMLDivElement | null>;
	renameInputRef: RefObject<HTMLInputElement>;
	getSearchResultInfo: (sessionId: string) => SearchResultInfo | undefined;
	onSessionsScroll: React.UIEventHandler<HTMLDivElement>;
	onViewSession: (session: AgentSession) => void;
	onToggleStar: (sessionId: string, e: React.MouseEvent) => void;
	onQuickResume: (session: AgentSession, e: React.MouseEvent) => void;
	onStartRename: (session: AgentSession, e: React.MouseEvent) => void;
	onRenameChange: (value: string) => void;
	onSubmitRename: (sessionId: string) => void;
	onCancelRename: () => void;
}

export const SessionListView = React.memo(function SessionListView({
	loading,
	sessions,
	filteredSessions,
	selectedIndex,
	starredSessions,
	activeAgentSessionId,
	renamingSessionId,
	renameValue,
	searchMode,
	search,
	isLoadingMoreSessions,
	hasMoreSessions,
	totalSessionCount,
	agentId,
	theme,
	sessionsContainerRef,
	selectedItemRef,
	renameInputRef,
	getSearchResultInfo,
	onSessionsScroll,
	onViewSession,
	onToggleStar,
	onQuickResume,
	onStartRename,
	onRenameChange,
	onSubmitRename,
	onCancelRename,
}: SessionListViewProps) {
	return (
		<div
			ref={sessionsContainerRef}
			className="flex-1 overflow-y-auto scrollbar-thin"
			onScroll={onSessionsScroll}
		>
			{loading ? (
				<div className="flex items-center justify-center py-12">
					<Spinner size={24} color={theme.colors.textDim} />
				</div>
			) : filteredSessions.length === 0 ? (
				<EmptyStatePlaceholder
					theme={theme}
					icon={<List className="w-12 h-12" />}
					title={
						sessions.length === 0
							? `No ${agentId === 'claude-code' ? 'Claude' : 'agent'} sessions found for this project`
							: 'No sessions match your search'
					}
				/>
			) : (
				<div className="py-2">
					{filteredSessions.map((session, i) => (
						<SessionListItem
							key={session.sessionId}
							session={session}
							index={i}
							selectedIndex={selectedIndex}
							isStarred={starredSessions.has(session.sessionId)}
							activeAgentSessionId={activeAgentSessionId}
							renamingSessionId={renamingSessionId}
							renameValue={renameValue}
							searchMode={searchMode}
							searchQuery={search}
							searchResultInfo={getSearchResultInfo(session.sessionId)}
							theme={theme}
							selectedItemRef={selectedItemRef}
							renameInputRef={renameInputRef}
							onSessionClick={onViewSession}
							onToggleStar={onToggleStar}
							onQuickResume={onQuickResume}
							onStartRename={onStartRename}
							onRenameChange={onRenameChange}
							onSubmitRename={onSubmitRename}
							onCancelRename={onCancelRename}
						/>
					))}
					{(isLoadingMoreSessions || hasMoreSessions) && !search && (
						<div className="py-4 flex justify-center items-center">
							{isLoadingMoreSessions ? (
								<div className="flex items-center gap-2">
									<Spinner size={16} color={theme.colors.accent} />
									<span className="text-xs" style={{ color: theme.colors.textDim }}>
										Loading more sessions...
									</span>
								</div>
							) : (
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{sessions.length} of {totalSessionCount} sessions loaded
								</span>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
});
