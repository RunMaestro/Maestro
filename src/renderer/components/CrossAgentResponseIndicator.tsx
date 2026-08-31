/**
 * CrossAgentResponseIndicator.tsx
 *
 * Compact pill shown while one or more cross-agent (`@mention`) responses are
 * streaming back into the currently-viewed AI tab (Phase 05). Purely
 * informational: the user keeps typing while consulted agents answer.
 *
 * Renders in normal flow at the top of the input area (next to the thinking
 * pill). Clicking it expands a small dropdown listing each in-flight request -
 * the consulted agent's name plus how long it has been running. Each agent chip is a deep
 * link: clicking it jumps to that agent AND to the consult tab actually running
 * the request (the same jump the response bubble's attribution header makes),
 * rather than landing on whatever tab that agent last had active. Renders
 * nothing when no cross-agent responses are in flight for this tab.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import type { Theme } from '../types';
import {
	selectInFlightForTab,
	useCrossAgentInFlightStore,
} from '../stores/crossAgentInFlightStore';
import { getAgentIcon } from '../constants/agentIcons';
import { formatElapsedTickerCompact, truncateText } from '../../shared/formatters';

interface CrossAgentResponseIndicatorProps {
	theme: Theme;
	/** The agent (session) currently on screen - the response destination. */
	sourceSessionId: string | null | undefined;
	/** The active AI tab within that agent (matches the dispatch's sourceTabId). */
	sourceTabId: string | null | undefined;
	/**
	 * Jump to an agent (and optionally one of its AI tabs). Shared with
	 * ThinkingStatusPill / ExecutionQueueIndicator, so a chip click lands the same
	 * way every other cross-agent navigation affordance does.
	 */
	onSessionClick?: (sessionId: string, tabId?: string) => void;
}

export function CrossAgentResponseIndicator({
	theme,
	sourceSessionId,
	sourceTabId,
	onSessionClick,
}: CrossAgentResponseIndicatorProps): JSX.Element | null {
	const requests = useCrossAgentInFlightStore((s) => s.requests);
	const inFlight = useMemo(
		() => selectInFlightForTab(requests, sourceSessionId, sourceTabId),
		[requests, sourceSessionId, sourceTabId]
	);

	const [expanded, setExpanded] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	const hasRequests = inFlight.length > 0;

	// Tick once a second while the dropdown is open so elapsed times stay live.
	useEffect(() => {
		if (!expanded || !hasRequests) return;
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, [expanded, hasRequests]);

	// Collapse automatically once every response has landed.
	useEffect(() => {
		if (!hasRequests && expanded) setExpanded(false);
	}, [hasRequests, expanded]);

	if (!hasRequests) return null;

	const count = inFlight.length;

	return (
		// Centered container with negative top margin to offset parent padding,
		// matching QuitWhenIdleIndicator / ThinkingStatusPill so the pills stack.
		<div className="relative flex justify-center pb-2 mb-2 -mt-2">
			{/* Pill + expanded agent chips share ONE row (wrapping if the fleet is
			    large), so the agents reveal to the RIGHT of the pill instead of a
			    dropdown below it. */}
			<div className="flex flex-row flex-wrap items-center justify-center gap-2">
				<button
					type="button"
					onClick={() => {
						setNow(Date.now());
						setExpanded((v) => !v);
					}}
					aria-expanded={expanded}
					className="flex items-center gap-2 pl-3 pr-2.5 py-1.5 rounded-full text-xs font-medium outline-none transition-colors hover:opacity-90"
					style={{
						backgroundColor: theme.colors.accent + '20',
						border: `1px solid ${theme.colors.border}`,
						color: theme.colors.textMain,
					}}
					title={expanded ? 'Hide consulted agents' : 'Show consulted agents'}
				>
					<Loader2
						className="w-3.5 h-3.5 shrink-0 animate-spin"
						style={{ color: theme.colors.accent }}
					/>
					<span className="shrink-0">
						{count} {count === 1 ? 'agent' : 'agents'} responding…
					</span>
					{/* Disclosure chevron: points right when collapsed, rotates down when
					    expanded, so the pill reads as clickable-to-reveal. */}
					<ChevronRight
						className={`w-3.5 h-3.5 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
						style={{ color: theme.colors.textDim }}
						aria-hidden
					/>
				</button>

				{expanded &&
					inFlight.map((req) => {
						// Seconds below a minute, then the same segments the thinking pill
						// below it shows - a long consult reads `20m 4s`, never `1203s`.
						const elapsed = formatElapsedTickerCompact(now - req.startedAt);
						// The chip is only a link when we can navigate. Without a handler it
						// stays a plain, non-focusable label rather than a button that does
						// nothing when clicked.
						const canJump = Boolean(onSessionClick);
						return (
							<button
								key={req.requestId}
								type="button"
								disabled={!canJump}
								onClick={() => onSessionClick?.(req.targetSessionId, req.targetTabId)}
								className={`flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full text-xs outline-none transition-colors ${
									canJump ? 'cursor-pointer hover:opacity-90' : 'cursor-default'
								}`}
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
									color: theme.colors.textMain,
								}}
								title={
									canJump
										? `Jump to ${req.targetAgentName} · ${elapsed}`
										: `${req.targetAgentName} · ${elapsed}`
								}
							>
								<span className="shrink-0 leading-none">
									{getAgentIcon(req.targetToolType ?? '')}
								</span>
								<span className="truncate max-w-[10rem]">
									{truncateText(req.targetAgentName, 24)}
								</span>
								<span className="shrink-0 tabular-nums" style={{ color: theme.colors.textDim }}>
									{elapsed}
								</span>
							</button>
						);
					})}
			</div>
		</div>
	);
}
