/**
 * The live transcript: what was said, where it went, and what is being said back.
 *
 * Three things happen here that a plain message list does not do:
 *
 *   - **Partials settle rather than jump.** An interim hypothesis renders as a
 *     dimmed, italic line at the bottom; when it settles it is replaced by the
 *     final in the feed. Rendering partials as ordinary lines would leave the
 *     scrollback full of half-heard sentences that were never actually said.
 *   - **Route chips are addresses, not decoration.** The line narrating a
 *     dispatch carries where it went, and the chip is clickable: "I said that
 *     out loud, where did it land" is the question this panel exists to answer,
 *     and answering it with text the user then has to go and find by hand
 *     answers only half of it.
 *   - **The sentence being spoken is highlighted.** The scheduler emits
 *     `speak-sentence` just BEFORE the audio reaches the sink, so the last
 *     sentence in the run is the one currently coming out of the speakers.
 *
 * Virtualized through `@tanstack/react-virtual` with `measureElement`, the same
 * pattern the group chat and history panels use: rows here are markdown and
 * genuinely variable in height, so a fixed row estimate would misplace the
 * scroll position on any reply longer than a line.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { CornerDownRight } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import type { DispatchAction } from '../../../shared/acappella/protocol';
import { jumpToVoiceTab } from '../../hooks/voice/useVoiceAgentActions';
import {
	useVoiceSessionStore,
	type VoiceFeedEntry,
	type VoiceFeedRoute,
	type VoiceSpeechRun,
} from '../../stores/voiceSessionStore';
import { Markdown } from '../Markdown';

export interface VoiceTranscriptProps {
	theme: Theme;
	/** Max height of the scroll area, in px. */
	maxHeight?: number;
}

/** Who said a line. `Maestro` is the session narrating itself. */
const KIND_LABELS: Record<VoiceFeedEntry['kind'], string> = {
	you: 'You',
	assistant: 'Agent',
	system: 'Maestro',
};

/** What the dispatch did to the tab, in the words the chip shows. */
const ACTION_LABELS: Record<DispatchAction, string> = {
	created: 'new tab',
	recalled: 'back to tab',
	focused: 'current tab',
};

/**
 * A row's height before it has been measured.
 *
 * Deliberately near the short end: an underestimate is corrected upward on the
 * first measure pass, while an overestimate leaves a gap under the last row that
 * the user sees as the list failing to reach the bottom.
 */
const ESTIMATED_ROW_HEIGHT = 34;

export function VoiceTranscript({ theme, maxHeight = 220 }: VoiceTranscriptProps) {
	const feed = useVoiceSessionStore((s) => s.feed);
	const partial = useVoiceSessionStore((s) => s.partialTranscript);
	const speech = useVoiceSessionStore((s) => s.speech);

	const containerRef = useRef<HTMLDivElement>(null);

	const virtualizer = useVirtualizer({
		count: feed.length,
		getScrollElement: () => containerRef.current,
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		getItemKey: (index) => feed[index]?.id ?? index,
		overscan: 6,
		// jsdom has no layout, so without a seed rect the virtualizer reports a zero
		// viewport and renders nothing at all - which would make every test here
		// pass against an empty list.
		initialRect: { width: 320, height: maxHeight },
	});

	// Follow the conversation. A voice transcript is read at the bottom by
	// definition: the interesting line is the one being said right now.
	useEffect(() => {
		const container = containerRef.current;
		if (!container || feed.length === 0) return;
		container.scrollTop = container.scrollHeight;
	}, [feed.length, partial, speech]);

	const accentText = useMemo(
		() => readableTextOn(theme.colors.accent, [theme.colors.bgSidebar]),
		[theme.colors.accent, theme.colors.bgSidebar]
	);

	const items = virtualizer.getVirtualItems();

	return (
		<div
			data-testid="voice-transcript"
			role="log"
			aria-label="Voice transcript"
			className="border-t select-text"
			style={{ borderColor: theme.colors.border }}
		>
			<div
				ref={containerRef}
				className="overflow-y-auto scrollbar-thin px-3 py-2"
				style={{ maxHeight }}
			>
				{feed.length === 0 && !partial && (
					<div className="text-[11px] italic" style={{ color: theme.colors.textDim }}>
						Nothing said yet.
					</div>
				)}

				{feed.length > 0 && (
					<div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
						{items.map((item) => {
							const entry = feed[item.index];
							if (!entry) return null;
							return (
								<div
									key={item.key}
									ref={virtualizer.measureElement}
									data-index={item.index}
									data-testid="voice-transcript-entry"
									data-kind={entry.kind}
									className="pb-1.5"
									style={{
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${item.start}px)`,
									}}
								>
									<TranscriptLine theme={theme} entry={entry} accentText={accentText} />
								</div>
							);
						})}
					</div>
				)}

				{/*
				 * The live hypothesis, outside the virtual list. It has no id, it is
				 * replaced wholesale on every update, and it is always last - giving it
				 * a row in a measured list would remeasure the whole tail several times
				 * a second for a line that is about to be deleted.
				 */}
				{partial && (
					<div
						data-testid="voice-transcript-partial"
						className="text-[11px] leading-snug italic pt-0.5"
						style={{ color: theme.colors.textDim }}
					>
						{partial}
					</div>
				)}

				{speech && speech.sentences.length > 0 && (
					<SpokenRun theme={theme} speech={speech} accentText={accentText} />
				)}
			</div>
		</div>
	);
}

function TranscriptLine({
	theme,
	entry,
	accentText,
}: {
	theme: Theme;
	entry: VoiceFeedEntry;
	accentText: string;
}) {
	return (
		<div className="text-[11px] leading-snug">
			<span
				className="font-bold mr-1"
				style={{ color: entry.kind === 'you' ? accentText : theme.colors.textDim }}
			>
				{KIND_LABELS[entry.kind]}
			</span>
			{entry.kind === 'assistant' ? (
				// Agents write markdown even when they are being read out loud, and the
				// shared chat preset is what already knows how to render it (and how to
				// make its file paths clickable). A hand-rolled ReactMarkdown here would
				// be a second, drifting copy of that map.
				<span className="inline-block align-top max-w-full">
					<Markdown preset="chat" theme={theme} content={entry.text} />
				</span>
			) : (
				<span style={{ color: theme.colors.textMain }}>{entry.text}</span>
			)}
			{entry.route && <RouteChip theme={theme} route={entry.route} />}
		</div>
	);
}

/**
 * "Backend / Auth Refactor (new tab)", clickable.
 *
 * A real `<button>` rather than a styled span: it navigates, so it has to be
 * reachable by keyboard and announced as something that can be activated.
 */
function RouteChip({ theme, route }: { theme: Theme; route: VoiceFeedRoute }) {
	const label = route.tabName ? `${route.agentName} / ${route.tabName}` : route.agentName;
	const description = `${label} (${ACTION_LABELS[route.action]})`;

	const onClick = useCallback(() => {
		jumpToVoiceTab(route.agentSessionId, route.tabId);
	}, [route.agentSessionId, route.tabId]);

	return (
		<button
			type="button"
			data-testid="voice-route-chip"
			data-agent-session-id={route.agentSessionId}
			data-tab-id={route.tabId}
			onClick={onClick}
			aria-label={`Go to ${description}`}
			title={`Go to ${description}`}
			className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] align-middle focus:outline-none focus-visible:ring-2 hover:opacity-80"
			style={{
				backgroundColor: theme.colors.bgActivity,
				color: readableTextOn(theme.colors.accent, [theme.colors.bgActivity]),
				border: `1px solid ${theme.colors.border}`,
			}}
		>
			<CornerDownRight className="w-2.5 h-2.5" aria-hidden="true" />
			<span className="truncate max-w-[180px]">{description}</span>
		</button>
	);
}

/**
 * The reply as it is spoken, one sentence at a time.
 *
 * Outside the virtual list for the same reason the partial is: it grows by one
 * sentence every couple of seconds and is always at the bottom, so it is cheaper
 * and steadier to render it whole than to keep remeasuring a growing tail row.
 */
function SpokenRun({
	theme,
	speech,
	accentText,
}: {
	theme: Theme;
	speech: VoiceSpeechRun;
	accentText: string;
}) {
	// `speak-sentence` is emitted just before the audio reaches the sink, so the
	// newest sentence is the one being heard - until the run ends, at which point
	// nothing is being spoken and nothing should be highlighted.
	const speakingIndex = speech.endedReason === null ? speech.sentences.length - 1 : -1;

	return (
		<div data-testid="voice-transcript-spoken" className="text-[11px] leading-snug pt-0.5">
			{speech.sentences.map((sentence, index) => {
				const current = index === speakingIndex;
				return (
					<span
						key={index}
						data-testid={current ? 'voice-transcript-speaking' : undefined}
						aria-current={current ? 'true' : undefined}
						style={{
							color: current ? accentText : theme.colors.textDim,
							fontWeight: current ? 600 : undefined,
						}}
					>
						{sentence}{' '}
					</span>
				);
			})}
			{speech.endedReason === 'cancelled' && (
				<span style={{ color: theme.colors.textDim }}>(cut off)</span>
			)}
		</div>
	);
}

export default VoiceTranscript;
