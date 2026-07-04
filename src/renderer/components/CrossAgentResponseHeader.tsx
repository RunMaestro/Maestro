/**
 * CrossAgentResponseHeader - attribution header rendered at the TOP of a
 * cross-agent (`@mention`) response bubble.
 *
 * A cross-agent reply is produced by a DIFFERENT agent the user consulted via
 * `@target`. When several agents answer at once (a group fan-out), this header
 * is what visually differentiates each reply from your own agent's output and
 * from every other consulted agent. It also gives the user a one-click path
 * back into the consulted agent to continue the dialogue in its own context.
 *
 * It surfaces, left to right:
 *   - a provider glyph (or a streaming spinner while the reply is still coming),
 *   - the consulted agent's display name - the primary jump affordance,
 *   - the provider (Claude Code / Codex / …),
 *   - the session id (click to copy),
 *   - an explicit jump button.
 *
 * Both the name and the jump button resolve to the same `maestro://session/<id>`
 * deep link the rendered `@mention` chips use (openMaestroLink +
 * buildSessionDeepLink), so clicking selects that agent in the Left Bar.
 */

import type React from 'react';
import { CornerUpRight, Loader2 } from 'lucide-react';
import type { LogEntry, Theme } from '../types';
import { getAgentIcon } from '../constants/agentIcons';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { truncateText } from '../../shared/formatters';
import { useSessionStore } from '../stores/sessionStore';
import { openMaestroLink } from '../utils/openMaestroLink';
import { buildSessionDeepLink } from '../../shared/deep-link-urls';
import { safeClipboardWrite } from '../utils/clipboard';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { notifyCenterFlash } from '../stores/centerFlashStore';

/** The `crossAgent` provenance stamped onto a cross-agent AI LogEntry. */
type CrossAgentMeta = NonNullable<NonNullable<LogEntry['metadata']>['crossAgent']>;

export interface CrossAgentResponseHeaderProps {
	crossAgent: CrossAgentMeta;
	theme: Theme;
}

/** First segment of a UUID - enough to identify a session without the noise. */
function shortSessionId(id: string): string {
	return id.split('-')[0] || id;
}

export function CrossAgentResponseHeader({
	crossAgent,
	theme,
}: CrossAgentResponseHeaderProps): JSX.Element {
	const isStreaming = !!crossAgent.streaming;
	const isError = !!crossAgent.error;
	const providerName = getAgentDisplayName(crossAgent.fromToolType);
	// The header hue tracks the bubble: accent normally, error red on a failed
	// consult (matches the crossAgentBubbleBorder derivation in TerminalOutput).
	const accent = isError ? theme.colors.error : theme.colors.accent;
	const ringStyle = { ['--tw-ring-color' as string]: accent } as React.CSSProperties;

	// Resolve at click time (not per-render) so the header stays cheap and never
	// subscribes to the session store: the consulted agent may have been deleted
	// since it answered, so we verify before jumping.
	const jumpToAgent = (): void => {
		const exists = useSessionStore
			.getState()
			.sessions.some((s) => s.id === crossAgent.fromSessionId);
		if (!exists) {
			notifyCenterFlash({
				message: `${crossAgent.fromAgentName} is no longer available`,
				color: 'orange',
			});
			return;
		}
		// Deep-link to the consult tab that holds the persisted answer when we have
		// its id, so the jump lands on the actual conversation rather than whatever
		// tab was last active. Falls back to a plain agent jump for older entries
		// (pre-persistence) that carry no `fromTabId`.
		openMaestroLink(buildSessionDeepLink(crossAgent.fromSessionId, crossAgent.fromTabId));
	};

	const copySessionId = async (): Promise<void> => {
		if (await safeClipboardWrite(crossAgent.fromSessionId)) {
			flashCopiedToClipboard(crossAgent.fromSessionId, 'Session ID copied');
		}
	};

	return (
		<div
			// Full-bleed bar: negative margins break out of the bubble's p-4 so the
			// header sits flush against the (overflow-hidden, rounded) top edge.
			className="-mx-4 -mt-4 mb-3 flex items-center gap-2 px-3 py-1.5 border-b select-none"
			style={{
				backgroundColor: `color-mix(in srgb, ${accent} 16%, transparent)`,
				borderColor: `color-mix(in srgb, ${accent} 30%, ${theme.colors.border})`,
			}}
		>
			{/* Provider glyph, or a spinner while the reply is still streaming in. */}
			{isStreaming ? (
				<Loader2
					className="w-3.5 h-3.5 shrink-0 animate-spin"
					style={{ color: accent }}
					aria-hidden
				/>
			) : (
				<span className="shrink-0 text-sm leading-none" aria-hidden>
					{getAgentIcon(crossAgent.fromToolType)}
				</span>
			)}

			{/* Agent name - primary click-to-jump affordance. */}
			<button
				type="button"
				onClick={jumpToAgent}
				className="min-w-0 text-xs font-semibold truncate hover:underline outline-none focus-visible:ring-2 rounded"
				style={{ color: accent, ...ringStyle }}
				title={`Open "${crossAgent.fromAgentName}" to continue this dialogue`}
			>
				{truncateText(crossAgent.fromAgentName, 28)}
			</button>

			{/* Provider label - muted, non-interactive. */}
			<span className="shrink-0 text-[10px] leading-none" style={{ color: theme.colors.textDim }}>
				{providerName}
			</span>

			{/* Session id - click to copy the full id. */}
			<button
				type="button"
				onClick={copySessionId}
				className="shrink-0 text-[10px] font-mono opacity-70 hover:opacity-100 outline-none focus-visible:ring-2 rounded px-0.5"
				style={{ color: theme.colors.textDim, ...ringStyle }}
				title={`Session ID: ${crossAgent.fromSessionId} (click to copy)`}
			>
				{shortSessionId(crossAgent.fromSessionId)}
			</button>

			{/* Explicit jump button, right-aligned. */}
			<button
				type="button"
				onClick={jumpToAgent}
				className="ml-auto shrink-0 p-1 rounded opacity-70 hover:opacity-100 outline-none focus-visible:ring-2"
				style={{ color: accent, ...ringStyle }}
				title={`Jump to ${crossAgent.fromAgentName}`}
				aria-label={`Jump to ${crossAgent.fromAgentName}`}
			>
				<CornerUpRight className="w-3.5 h-3.5" />
			</button>

			{isError && (
				<span className="sr-only">Consulted agent could not respond: {crossAgent.error}</span>
			)}
		</div>
	);
}

export default CrossAgentResponseHeader;
