/**
 * AgentsLoadingView - shown while the initial agent list is still loading.
 *
 * On the desktop app the native splash screen covers startup until
 * `sessionsLoaded` flips true, so this view is rarely visible there. It exists
 * for the Web Desktop, which has no splash: while `sessions.getBootstrap()` is
 * in flight over the WebSocket bridge, the session list is momentarily empty.
 * Without this, App.tsx would fall through to EmptyStateView and flash "Create
 * your first agent" before the agents arrive. Gating EmptyStateView on
 * `sessionsLoaded` and rendering this spinner in the meantime keeps the
 * experience honest. A read that FAILED (`readFailed`) stays here with a Retry
 * rather than falling through to the empty state, since the agents still exist.
 */

import { Wand2 } from 'lucide-react';
import { Wordmark } from './ui/Wordmark';
import type { Theme } from '../types';
import { Spinner } from './ui/Spinner';
import { requestWebBridgeReconcile } from '../services/webBridgeReconcile';

interface AgentsLoadingViewProps {
	theme: Theme;
	readFailed?: boolean;
}

export function AgentsLoadingView({ theme, readFailed = false }: AgentsLoadingViewProps) {
	return (
		<div className="flex-1 flex flex-col" style={{ backgroundColor: theme.colors.bgMain }}>
			{/* Top Bar - mirrors EmptyStateView so the transition is seamless */}
			<div
				className="h-16 border-b flex items-center px-4 shrink-0"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<div className="flex items-center gap-2">
					<Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<Wordmark as="h1" className="text-lg" style={{ color: theme.colors.textMain }} />
				</div>
			</div>

			{/* Centered spinner */}
			<div className="flex-1 flex flex-col items-center justify-center gap-4 px-4">
				{!readFailed && (
					<Spinner size={28} color={theme.colors.textDim} ariaLabel="Loading agents" />
				)}
				<span className="text-sm" style={{ color: theme.colors.textDim }}>
					{readFailed
						? 'Could not load your agents. Your saved agents are untouched.'
						: 'Loading your agents...'}
				</span>
				{readFailed && (
					<button
						type="button"
						className="rounded-lg px-4 py-2 text-sm"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						onClick={requestWebBridgeReconcile}
					>
						Retry
					</button>
				)}
			</div>
		</div>
	);
}
