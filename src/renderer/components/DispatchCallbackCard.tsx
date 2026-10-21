/**
 * DispatchCallbackCard - the transcript card where a dispatch this agent sent
 * came back.
 *
 * The outbound hand-off already reads as a clean pill (`AgentDelegationCard`).
 * The return did not: it arrived as the raw `[Maestro dispatch callback]`
 * prompt and looked like any other message. This closes that asymmetry. The
 * agent-facing text is unchanged (it must stay a real prompt the orchestrator
 * reads); this card is only what the human sees, parsed from that text by
 * `parseDispatchCallbackPrompt()`.
 *
 * Collapsed by default: status, exit, duration, and a one-line preview. Click
 * to expand a hard-capped result snippet in place; click the corner arrow to
 * jump to the source tab for the full, uncapped transcript. The output was
 * already tail-capped at `DISPATCH_OUTPUT_MAX_CHARS` upstream, and the preview
 * is capped tighter again here, so the card can never become a wall of text.
 */

import React, { useMemo, useState } from 'react';
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	CornerDownLeft,
	CornerUpRight,
	XCircle,
} from 'lucide-react';

import type { Theme } from '../types';
import type {
	DispatchCallbackStatus,
	ParsedDispatchCallback,
} from '../../shared/dispatchCallbackCard';
import { truncateAtWordBoundary } from '../../shared/formatters';
import { getAgentIconForToolType } from '../constants/agentIcons';
import { jumpToAgentConversation } from '../utils/jumpToAgentConversation';
import { MarkdownRenderer } from './MarkdownRenderer';
import { MiniBadge } from './ui/MiniBadge';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import type { ToolType } from '../../shared/types';

export interface DispatchCallbackCardProps {
	parsed: ParsedDispatchCallback;
	theme: Theme;
	/** The target agent's toolType, if resolvable, for its provider glyph. */
	targetToolType?: ToolType;
}

/** How much of the result the expanded preview shows before "open the tab". */
const PREVIEW_MAX_CHARS = 400;

/** Status drives the accent hue, icon, and the chip wording. */
function statusStyle(
	status: DispatchCallbackStatus,
	theme: Theme
): { accent: string; Icon: typeof CheckCircle2; badge?: string } {
	switch (status) {
		case 'completed':
			return { accent: theme.colors.success, Icon: CheckCircle2 };
		case 'failed':
			return { accent: theme.colors.error, Icon: XCircle, badge: 'Failed' };
		case 'timeout':
			return { accent: theme.colors.warning, Icon: AlertTriangle, badge: 'Timed out' };
		case 'cancelled':
			return { accent: theme.colors.textDim, Icon: XCircle, badge: 'Cancelled' };
		default:
			return { accent: theme.colors.accent, Icon: CheckCircle2 };
	}
}

export function DispatchCallbackCard({
	parsed,
	theme,
	targetToolType,
}: DispatchCallbackCardProps): React.ReactElement {
	const [expanded, setExpanded] = useState(false);
	const { accent, Icon, badge } = statusStyle(parsed.status, theme);

	const hasTasks = parsed.tasksTotal !== 'n/a' && parsed.tasksCompleted !== 'n/a';
	const exitLabel = parsed.exitCode === 'n/a' ? null : `exit ${parsed.exitCode}`;

	// The expanded body is hard-capped here; the full result lives in the tab.
	const preview = useMemo(
		() => (parsed.output ? truncateAtWordBoundary(parsed.output, PREVIEW_MAX_CHARS) : ''),
		[parsed.output]
	);
	const truncated = parsed.output.length > preview.length;

	const jump = (): void =>
		jumpToAgentConversation({
			sessionId: parsed.targetAgentId,
			tabId: parsed.tabId,
			agentName: parsed.targetName,
		});

	const ringStyle = { ['--tw-ring-color' as string]: accent } as React.CSSProperties;

	const handleCopy = (text: string): void => {
		void navigator.clipboard?.writeText(text);
		flashCopiedToClipboard();
	};

	return (
		<div
			className="max-w-full rounded-2xl border text-xs select-none"
			style={{
				backgroundColor: `color-mix(in srgb, ${accent} 10%, transparent)`,
				borderColor: `color-mix(in srgb, ${accent} 35%, ${theme.colors.border})`,
			}}
			data-testid="dispatch-callback-card"
		>
			{/* Header row: status, who it came from, exit/duration, jump. */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
				<CornerDownLeft className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} aria-hidden />
				<Icon className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} aria-hidden />

				<span className="shrink-0" style={{ color: theme.colors.textDim }}>
					Returned from
				</span>

				<button
					type="button"
					onClick={jump}
					className="inline-flex items-center gap-1 text-left font-semibold hover:underline outline-none focus-visible:ring-2 rounded"
					style={{ color: accent, ...ringStyle }}
					title={`Open "${parsed.targetName}"`}
				>
					{targetToolType && (
						<span className="shrink-0 leading-none" aria-hidden>
							{getAgentIconForToolType(targetToolType)}
						</span>
					)}
					<span className="break-words" data-testid="dispatch-callback-target">
						{parsed.targetName}
					</span>
				</button>

				{badge && (
					<MiniBadge label={badge} theme={theme} color={accent} testId="dispatch-callback-status" />
				)}

				<span
					className="shrink-0 text-2xs leading-none"
					style={{ color: theme.colors.textDim }}
					data-testid="dispatch-callback-meta"
				>
					{[
						exitLabel,
						parsed.duration,
						hasTasks ? `${parsed.tasksCompleted}/${parsed.tasksTotal}` : null,
					]
						.filter(Boolean)
						.join('  ·  ')}
				</span>

				{parsed.output && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						className="inline-flex items-center gap-0.5 text-2xs shrink-0 outline-none focus-visible:ring-2 rounded px-0.5"
						style={{ color: theme.colors.textDim, ...ringStyle }}
						aria-expanded={expanded}
						data-testid="dispatch-callback-toggle"
					>
						{expanded ? (
							<ChevronDown className="w-3 h-3" aria-hidden />
						) : (
							<ChevronRight className="w-3 h-3" aria-hidden />
						)}
						result
					</button>
				)}

				<button
					type="button"
					onClick={jump}
					className="ml-auto shrink-0 p-0.5 rounded opacity-70 hover:opacity-100 outline-none focus-visible:ring-2"
					style={{ color: accent, ...ringStyle }}
					title={`Open ${parsed.targetName} tab`}
					aria-label={`Open ${parsed.targetName} tab`}
				>
					<CornerUpRight className="w-3.5 h-3.5" />
				</button>
			</div>

			{/* Expanded: capped result preview, rendered markdown, with a line to
			    the full transcript. select-text because this subtree is content. */}
			{expanded && parsed.output && (
				<div
					className="px-2.5 pb-2 pt-1 border-t select-text"
					style={{ borderColor: `color-mix(in srgb, ${accent} 20%, ${theme.colors.border})` }}
				>
					<MarkdownRenderer content={preview} theme={theme} onCopy={handleCopy} />
					{truncated && (
						<button
							type="button"
							onClick={jump}
							className="mt-1 text-2xs hover:underline outline-none focus-visible:ring-2 rounded"
							style={{ color: accent, ...ringStyle }}
						>
							Open the tab for the full result ↗
						</button>
					)}
				</div>
			)}
		</div>
	);
}

export default DispatchCallbackCard;
