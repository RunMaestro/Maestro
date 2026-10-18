/**
 * ThoughtStreamPanel - floating, persistent introspection of an Auto Run's
 * live thinking/reasoning stream.
 *
 * Mounted once, app-wide (next to CenterFlash in App.tsx). It reads
 * `thoughtStreamStore` and renders nothing until a session's panel is opened
 * via the brain button on the Auto Run card.
 *
 * Two states: hidden (no session focused) and open (the full panel - a
 * searchable, auto-tailing thought log).
 *
 * Under the header sits ONE bar with two jobs. While a run can be steered it
 * rests as two labelled buttons, Search and Steer, and clicking either swaps
 * the whole bar for that input; sending or leaving puts the buttons back.
 * Steering used to be a fourth dim icon in the header, which is how a feature
 * that changes what the run does next came to look like a view toggle.
 *
 * The panel is a VIEWER, not the capture switch: buffering runs ambiently in
 * the store, so closing does not stop it and reopening shows everything the
 * agent thought while the panel was away. Discarding is the explicit trash
 * button. That is also why there is no minimize - it used to mean "hide but
 * keep capturing", which is what closing does now.
 *
 * It registers a PASSIVE layer (`blocksAppShortcuts: false`): Escape closes it
 * at the right priority, but it takes no focus and must not make the app's
 * shortcuts go dead while the user reads a wedged run's reasoning.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
	AlertTriangle,
	Brain,
	Check,
	ChevronDown,
	ChevronRight,
	Compass,
	CornerDownRight,
	Loader2,
	Search,
	SendHorizonal,
	Trash2,
	Wrench,
	X,
} from 'lucide-react';
import type { Theme } from '../types';
import {
	useThoughtStreamStore,
	buildActivityFeed,
	isThoughtStreamLive,
	isToolEvent,
	THOUGHT_LIVE_WINDOW_MS,
	type ActivityFeedItem,
	type StreamEvent,
	type ToolActivityEntry,
} from '../stores/thoughtStreamStore';
import { useSessionStore } from '../stores/sessionStore';
import { useBatchStore } from '../stores/batchStore';
import {
	groupSteeringDeliveries,
	selectDeliveredSteeringNotes,
	selectPendingSteeringNotes,
	useAutoRunSteeringStore,
	type SteeringDelivery,
} from '../stores/autoRunSteeringStore';
import {
	cancelSteeringNote,
	steeringBlocker,
	submitSteeringNote,
} from '../services/autoRunSteering';
import { MAX_STEERING_NOTE_LENGTH, type AutoRunSteeringNote } from '../../shared/autorunSteering';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { usePersistedToggle } from '../hooks/ui/usePersistedToggle';
import { useAutosizeTextarea } from '../hooks/ui/useAutosizeTextarea';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { GhostIconButton } from './ui/GhostIconButton';
import { CountBadge } from './ui/CountBadge';
import { InlineCode } from './Markdown/components/InlineCode';
import { Markdown } from './Markdown';
import { generateTerminalProseStyles } from '../utils/markdownConfig';

/**
 * localStorage key for the tool-call display toggle. A view preference, not a
 * setting: it belongs to the panel, a user flips it by clicking, and it has to
 * survive the panel unmounting (closing it, or the Right Panel folding away).
 */
export const SHOW_TOOL_ACTIVITY_KEY = 'thoughtStream.showToolActivity';

/**
 * What the bar under the header is showing: the two buttons, or the input one
 * of them opened.
 */
type BarMode = 'buttons' | 'search' | 'steer';

/** Tallest the steering note box grows before it scrolls instead. */
const STEER_COMPOSER_MAX_HEIGHT = 120;

/**
 * Panel widths below which a bar button drops to a one-word label rather than
 * truncating mid-phrase. Two thresholds because the buttons are equal halves
 * and the labels are not equal lengths: at the Right Panel's default width
 * "Steer Auto Run" still fits its half and "Search thought stream" does not.
 */
const COMPACT_SEARCH_LABEL_WIDTH = 380;
const COMPACT_STEER_LABEL_WIDTH = 310;

interface ThoughtStreamPanelProps {
	theme: Theme;
}

/** Format a block timestamp as a stable time-of-day stamp (e.g. "3:42:07 PM"). */
function formatThoughtTime(ts: number): string {
	return new Date(ts).toLocaleTimeString([], {
		hour: 'numeric',
		minute: '2-digit',
		second: '2-digit',
	});
}

/** The full one-line rendering of a tool call ("Ran npm test"). */
function toolActivityText(activity: ToolActivityEntry): string {
	const { verb, target } = activity.tool.label;
	return target ? `${verb} ${target}` : verb;
}

/**
 * One tool call: a muted timestamp-and-status line, then the call itself on a
 * line of its own - verb, then target. Same two-line shape as a thought block,
 * so the two row kinds scan as one column rather than two layouts.
 *
 * The verb is our prose and stays in the interface font; a literal target (a
 * path, a command, a glob) renders as inline code, which is what it is. That
 * split is why the whole line is not simply set in a code face: "Ran" is not
 * something you can run, and dressing it as code makes the eye stop on the word
 * instead of the command beside it. `targetIsCode` carries the decision from
 * `describeToolActivity`, which is the only place that knows whether it built a
 * literal or a sentence.
 *
 * The text is still rendered as PLAIN TEXT, never markdown. A shell command or
 * a glob pattern is full of characters markdown claims (`*`, `_`, backticks),
 * so running it through the renderer mangles exactly the lines a user is trying
 * to read. The code chip is therefore applied by hand, via the same `<code>`
 * element and the same scoped `.thought-stream-prose code` rule that styles
 * real backticks in the reasoning blocks above - identical to markdown's inline
 * code because it IS markdown's inline code, minus the parser. Reusing the
 * shared `InlineCode` leaf keeps the click-to-copy behavior identical too, so
 * two things that look the same in this panel also behave the same.
 *
 * Search highlighting is done here rather than delegated, and per segment: a
 * query spanning the verb/target boundary still MATCHES the row (the filter
 * reads the joined line) but highlights nothing, which beats splitting a
 * `<mark>` across the chip edge.
 */
function ToolActivityRow({
	activity,
	theme,
	query,
}: {
	activity: ToolActivityEntry;
	theme: Theme;
	query: string;
}) {
	const { status } = activity.tool;
	const { verb, target, targetIsCode } = activity.tool.label;
	const color =
		status === 'failed'
			? theme.colors.error
			: status === 'running'
				? theme.colors.accent
				: theme.colors.textDim;

	return (
		<div data-testid="thought-stream-tool-row">
			{/* Metadata line: when it happened and how it ended. It sits ABOVE the
			    content rather than beside it, matching the thought rows, because a
			    timestamp gutter costs the same left third of the panel on every row
			    and the thing being squeezed into what is left is a shell command -
			    the one kind of text here that cannot be re-wrapped without becoming
			    hard to read. The status glyph rides this line for the same reason:
			    anything on the content line narrows the content line. */}
			<div
				className="flex items-center gap-1.5 text-2xs font-mono mb-1 select-none"
				style={{ color: theme.colors.textDim }}
			>
				<span title={new Date(activity.timestamp).toLocaleString()}>
					{formatThoughtTime(activity.timestamp)}
				</span>
				<span className="flex items-center" style={{ color }}>
					{status === 'running' ? (
						<Loader2 className="w-3 h-3 animate-spin" aria-label="running" />
					) : status === 'failed' ? (
						<AlertTriangle className="w-3 h-3" aria-label="failed" />
					) : (
						<Check className="w-3 h-3" aria-label="completed" />
					)}
				</span>
			</div>
			<div
				className="text-xs-plus leading-snug break-words"
				style={{ color: theme.colors.textMain }}
			>
				{highlightQuery(verb, query, theme)}
				{target && ' '}
				{target &&
					(targetIsCode ? (
						<InlineCode className="font-mono">{highlightQuery(target, query, theme)}</InlineCode>
					) : (
						highlightQuery(target, query, theme)
					))}
			</div>
		</div>
	);
}

/**
 * Split `text` on the search query and wrap the matches. Case-insensitive and
 * literal (the query is user text, never a pattern).
 */
function highlightQuery(text: string, query: string, theme: Theme) {
	const q = query.trim();
	if (!q) return text;
	const lower = text.toLowerCase();
	const needle = q.toLowerCase();
	const parts: React.ReactNode[] = [];
	let from = 0;
	for (;;) {
		const at = lower.indexOf(needle, from);
		if (at === -1) break;
		if (at > from) parts.push(text.slice(from, at));
		parts.push(
			<mark key={at} style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}>
				{text.slice(at, at + needle.length)}
			</mark>
		);
		from = at + needle.length;
	}
	if (parts.length === 0) return text;
	if (from < text.length) parts.push(text.slice(from));
	return parts;
}

/**
 * One steering note in the panel's strip.
 *
 * Pending and delivered are the SAME row with different affordances rather than
 * two components: the operator is reading one list of things they said, and the
 * only difference is whether it can still be taken back. A delivered note keeps
 * a check glyph instead of a cancel button, so the row never offers to un-send
 * something a task has already read.
 */
function SteeringNoteRow({
	note,
	theme,
	onCancel,
}: {
	note: AutoRunSteeringNote;
	theme: Theme;
	onCancel?: () => void;
}) {
	const pending = !!onCancel;
	return (
		<div
			className="flex items-start gap-1.5 text-2xs leading-snug"
			data-testid={pending ? 'steering-note-pending' : 'steering-note-delivered'}
		>
			<Compass
				className="w-3 h-3 mt-0.5 shrink-0"
				style={{ color: pending ? theme.colors.warning : theme.colors.success, opacity: 0.8 }}
			/>
			<span
				className="flex-1 min-w-0 break-words whitespace-pre-wrap"
				style={{ color: pending ? theme.colors.textMain : theme.colors.textDim }}
				title={`${formatThoughtTime(note.timestamp)} - ${
					pending ? 'waiting for the next task' : 'delivered to a task'
				}`}
			>
				{note.text}
			</span>
			{onCancel ? (
				<button
					onClick={onCancel}
					className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
					title="Cancel this steering note"
					aria-label="Cancel steering note"
				>
					<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			) : (
				<Check
					className="w-3 h-3 mt-0.5 shrink-0"
					style={{ color: theme.colors.success, opacity: 0.6 }}
					aria-label="delivered"
				/>
			)}
		</div>
	);
}

/**
 * What the task that took a delivery's notes said back.
 *
 * Three states, because "delivered" on its own answers the wrong question: the
 * operator is not asking whether the note reached a prompt, they are asking
 * what the agent did about it.
 *
 * - No reply, run in flight: the task is still working, so say so.
 * - No reply, run over: the task was stopped before it answered. A spinner here
 *   would spin forever over a run that no longer exists.
 * - Reply: the task's one-line synopsis, opening to its whole response.
 *
 * The collapsed line is the synopsis rather than a clamp of the full text: the
 * Auto Run prompt has a steered task lead with `[steered]` and what it changed,
 * which is exactly the sentence worth showing in two lines. The full reply is
 * markdown and renders as markdown, in the same scoped prose styles as the
 * reasoning blocks below it.
 */
function SteeringReply({
	delivery,
	theme,
	runInFlight,
	expanded,
	onToggle,
}: {
	delivery: SteeringDelivery;
	theme: Theme;
	runInFlight: boolean;
	expanded: boolean;
	onToggle: () => void;
}) {
	const { response } = delivery;

	if (!response) {
		return (
			<div
				className="flex items-center gap-1.5 pl-[18px] text-2xs italic"
				style={{ color: theme.colors.textDim }}
				data-testid="steering-reply-waiting"
			>
				{runInFlight ? (
					<>
						<Loader2 className="w-3 h-3 shrink-0 animate-spin" />
						The task that took this is still working
					</>
				) : (
					'The run ended before this task replied'
				)}
			</div>
		);
	}

	const color = response.success ? theme.colors.textMain : theme.colors.error;
	// Nothing to open when the reply is its own summary (a failure with no
	// output, or a one-line response).
	const hasMore = response.text.length > 0 && response.text !== response.summary;
	const Chevron = expanded ? ChevronDown : ChevronRight;

	return (
		<div className="pl-[18px]" data-testid="steering-reply">
			<button
				type="button"
				onClick={onToggle}
				disabled={!hasMore}
				aria-expanded={hasMore ? expanded : undefined}
				className="w-full flex items-start gap-1.5 text-left text-2xs leading-snug rounded px-1.5 py-1 transition-colors enabled:hover:bg-white/5 disabled:cursor-default"
				style={{ backgroundColor: theme.colors.bgActivity, color }}
				title={`${formatThoughtTime(response.timestamp)} - ${
					response.success ? 'reply from the task that took this' : 'the task that took this failed'
				}`}
			>
				{response.success ? (
					<CornerDownRight
						className="w-3 h-3 mt-0.5 shrink-0"
						style={{ color: theme.colors.textDim }}
					/>
				) : (
					<AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" aria-label="failed" />
				)}
				<span className={`flex-1 min-w-0 break-words ${expanded ? '' : 'line-clamp-2'}`}>
					{response.summary || response.text}
				</span>
				{hasMore && (
					<Chevron className="w-3 h-3 mt-0.5 shrink-0" style={{ color: theme.colors.textDim }} />
				)}
			</button>
			{expanded && hasMore && (
				<div
					className="thought-stream-prose prose max-w-none break-words select-text mt-1.5 px-1.5"
					style={{ fontSize: '0.75rem', color: theme.colors.textMain }}
					data-testid="steering-reply-full"
				>
					<Markdown preset="document" content={response.text} theme={theme} frontmatter={false} />
				</div>
			)}
		</div>
	);
}

export function ThoughtStreamPanel({ theme }: ThoughtStreamPanelProps) {
	const panelSessionId = useThoughtStreamStore((s) => s.panelSessionId);
	const buffer = useThoughtStreamStore((s) =>
		panelSessionId ? s.buffers[panelSessionId] : undefined
	);
	const closePanel = useThoughtStreamStore((s) => s.closePanel);
	const clearBuffer = useThoughtStreamStore((s) => s.clearBuffer);

	const sessionName = useSessionStore((s) =>
		panelSessionId ? s.sessions.find((sess) => sess.id === panelSessionId)?.name : undefined
	);

	// The panel is fixed to the viewport but should live INSIDE the Right Panel
	// (which is docked to the right edge with width `rightPanelWidth`): narrower
	// than the panel, horizontally centered in it, and growing/shrinking with it.
	const rightPanelOpen = useUIStore((s) => s.rightPanelOpen);
	const rightPanelWidth = useSettingsStore((s) => s.rightPanelWidth);

	const [query, setQuery] = useState('');
	const scrollRef = useRef<HTMLDivElement>(null);

	// Steering: which input the bar is showing lives here, the note itself lives
	// in autoRunSteeringStore. Auto Run steering is a property of the RUN, so this
	// panel is where it is offered - a note typed at the agent's chat composer
	// would be a message that silently meant something else.
	const [barMode, setBarMode] = useState<BarMode>('buttons');
	const [steerDraft, setSteerDraft] = useState('');
	const steerRef = useRef<HTMLTextAreaElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);

	// Only a run THIS client owns can be steered. `steeringBlocker` is the one
	// statement of that rule, shared with `maestro-cli steer-auto-run`.
	const canSteer = useBatchStore(
		(st) => steeringBlocker(panelSessionId ? st.batchRunStates[panelSessionId] : undefined) === null
	);
	const pendingNotes = useAutoRunSteeringStore(selectPendingSteeringNotes(panelSessionId ?? ''));
	const deliveredNotes = useAutoRunSteeringStore(
		selectDeliveredSteeringNotes(panelSessionId ?? '')
	);
	// One entry per task that took notes: the notes it took, then its one reply.
	const deliveries = useMemo(() => groupSteeringDeliveries(deliveredNotes), [deliveredNotes]);
	// One reply open at a time. The strip is a few lines tall by design, and two
	// open replies would push the stream it sits above off the panel.
	const [expandedDeliveryId, setExpandedDeliveryId] = useState<string | null>(null);
	// Newest blocks render on top, so "following" the live stream means staying
	// pinned to the TOP of the scroll area, not the bottom.
	const stickToTopRef = useRef(true);

	const entries: StreamEvent[] = useMemo(() => buffer?.entries ?? [], [buffer]);
	const trimmed = buffer?.trimmed ?? false;
	const lastAppendAt = buffer?.lastAppendAt ?? 0;

	// "Live" is a display affordance only (capture never stops): true while
	// thoughts are still arriving, and it goes stale on its own timer so a run
	// that quietly wedged stops claiming to be thinking.
	const [live, setLive] = useState(() => isThoughtStreamLive(lastAppendAt));
	useEffect(() => {
		if (!isThoughtStreamLive(lastAppendAt)) {
			setLive(false);
			return;
		}
		setLive(true);
		const timer = setTimeout(() => setLive(false), THOUGHT_LIVE_WINDOW_MS);
		return () => clearTimeout(timer);
	}, [lastAppendAt]);

	// Tool-call display is a VIEW filter, never a capture switch - the same rule
	// the panel itself follows. Turning actions off while a run grinds must not
	// lose the actions it took while they were hidden, so the timeline keeps
	// filling and turning them back on shows all of it.
	const { value: showToolActivity, toggle: toggleToolActivity } = usePersistedToggle(
		SHOW_TOOL_ACTIVITY_KEY,
		true
	);

	// Hiding actions REMOVES them from the timeline the feed is built from
	// rather than hiding the rendered rows. A tool call closes the open thought
	// block, so dropping the row alone would leave the reasoning fragmented into
	// mystery blocks split by an event the user can no longer see. Filtering
	// first lets the reasoning coalesce exactly as if the agent had never called
	// a tool, and the 3s gap rule still splits where a long call actually paused
	// the thinking.
	const timeline: StreamEvent[] = useMemo(
		() => (showToolActivity ? entries : entries.filter((event) => !isToolEvent(event))),
		[entries, showToolActivity]
	);

	// One walk of the session's timeline produces the whole feed: granular
	// thinking flushes coalesced into timestamped blocks, tool calls sitting
	// between the reasoning they interrupted. Displayed newest-first (the live
	// row sits at the top; older rows scroll down into history).
	const feed: ActivityFeedItem[] = useMemo(() => buildActivityFeed(timeline), [timeline]);

	// Header counts. Tool calls and reasoning are counted separately because
	// they answer different questions: "is it still thinking" vs "is it actually
	// doing anything", and a run stuck in a loop shows a climbing action count
	// against flat reasoning. The action count is read off the WHOLE buffer, so
	// it keeps climbing while the rows are hidden - that loop signal is the one
	// thing the toggle must not take away.
	const thoughtCount = useMemo(() => feed.filter((i) => i.kind === 'thought').length, [feed]);
	const actionCount = useMemo(() => entries.filter(isToolEvent).length, [entries]);

	const searching = query.trim().length > 0;

	// What the bar actually draws. With nothing to steer there is no choice to
	// offer, so the bar is simply the search box. A live query also holds it in
	// search: a filter that is narrowing the feed has to stay on screen and
	// clearable, not hide behind a button that says nothing is filtered.
	const bar: BarMode = !canSteer || (barMode === 'buttons' && searching) ? 'search' : barMode;

	// The feed is empty ONLY because the toggle is off: the agent did work, we
	// are just not drawing it.
	const hiddenActionsOnly = !showToolActivity && feed.length === 0 && actionCount > 0;

	// Compact, theme-aware prose styling for the rendered thought markdown,
	// scoped so it can't bleed into other prose containers (shared generator).
	const proseStyles = useMemo(
		() => generateTerminalProseStyles(theme, '.thought-stream-prose'),
		[theme]
	);

	const visibleFeed = useMemo(() => {
		const q = query.trim().toLowerCase();
		const matched = q
			? feed.filter((item) =>
					item.kind === 'thought'
						? item.block.text.toLowerCase().includes(q)
						: // Match the rendered line AND the raw provider tool name, so
							// searching "Bash" finds calls the feed renders as "Ran ...".
							toolActivityText(item.activity).toLowerCase().includes(q) ||
							item.activity.tool.name.toLowerCase().includes(q)
				)
			: feed;
		// Reverse a copy for newest-on-top display without mutating the memoized list.
		return [...matched].reverse();
	}, [feed, query]);

	// Steering is only on offer while a run this client owns is in flight, so a
	// run that ends with the composer open must put it away rather than leave a
	// Send button that can no longer deliver anything.
	useEffect(() => {
		if (!canSteer) {
			setBarMode('buttons');
			setSteerDraft('');
		}
	}, [canSteer]);

	// Hand the caret to whichever input a button just opened. The panel registers
	// a PASSIVE layer, so nothing else does; without this the operator clicks
	// Steer and then has to click again to type. Keyed on the button press rather
	// than on what the bar draws, so the search box that is simply always there
	// between runs never pulls focus when the panel opens.
	useEffect(() => {
		if (barMode === 'steer') steerRef.current?.focus();
		else if (barMode === 'search') searchRef.current?.focus();
	}, [barMode]);

	// The note box is one line until the note is not. `bar` re-measures a draft
	// that was kept across an Escape and is being shown again.
	useAutosizeTextarea({
		textareaRef: steerRef,
		value: steerDraft,
		maxHeight: STEER_COMPOSER_MAX_HEIGHT,
		resetKey: bar,
	});

	const sendSteeringNote = () => {
		if (!panelSessionId) return;
		if (!steerDraft.trim()) return;
		// Keep the draft on refusal (the pending cap): the note is the operator's
		// text, and the service has already said on screen why it did not land.
		if (!submitSteeringNote({ sessionId: panelSessionId, text: steerDraft })) return;
		setSteerDraft('');
		setBarMode('buttons');
	};

	// Leaving search drops the filter with it: the buttons say nothing about a
	// query, so one left active would be narrowing the feed invisibly.
	const leaveSearch = () => {
		setQuery('');
		setBarMode('buttons');
	};

	// Escape closes the panel - but it steps the bar back to its buttons first,
	// so a reflex Escape while typing does not put away the whole panel and lose
	// the draft with it. Between runs the bar has no buttons to step back to, so
	// Escape closes the panel as it always did.
	const handleEscape = () => {
		if (bar === 'steer') {
			setBarMode('buttons');
			return;
		}
		if (canSteer && bar === 'search') {
			leaveSearch();
			return;
		}
		closePanel();
	};

	// Nothing is lost by closing: the buffer outlives the panel, so Escape is a
	// "put it away", not a discard.
	useModalLayer(MODAL_PRIORITIES.THOUGHT_STREAM, 'Thought Stream', handleEscape, {
		enabled: !!panelSessionId,
		blocksLowerLayers: false,
		capturesFocus: false,
		blocksAppShortcuts: false,
		focusTrap: 'none',
	});

	// Auto-tail: when pinned to the top and not searching, follow new thoughts
	// (newest block is at the top).
	useEffect(() => {
		if (searching) return;
		if (!stickToTopRef.current) return;
		const el = scrollRef.current;
		if (el) el.scrollTop = 0;
	}, [visibleFeed, searching]);

	if (!panelSessionId) return null;

	const label = sessionName || `${panelSessionId.slice(0, 8)}`;

	// The Thought Stream lives inside the Right Panel, so it folds away with it:
	// when the Right Panel is collapsed we render nothing and the panel returns
	// when it re-opens. Capture is unaffected (the store/listener are independent
	// of this panel mounting).
	if (!rightPanelOpen) return null;

	// Inset the panel within the Right Panel: a gutter on each side keeps it
	// narrower than the panel and centers it (the Right Panel hugs the viewport's
	// right edge, so an equal `right` offset and width reduction = centered). The
	// gutter scales with panel width so it tracks resize.
	const gutter = Math.round(Math.min(40, Math.max(12, rightPanelWidth * 0.06)));
	const panelWidth = Math.max(280, rightPanelWidth - gutter * 2);
	const steerButtonTitle = pendingNotes.length
		? `Steer the Auto Run (${pendingNotes.length} note${pendingNotes.length === 1 ? '' : 's'} waiting for the next task)`
		: 'Steer the Auto Run - send a note that opens the next task';

	// --- Full panel ---------------------------------------------------------
	return (
		<div
			className="fixed bottom-4 z-[9998] flex flex-col rounded-lg border shadow-2xl select-none"
			style={{
				right: gutter,
				width: panelWidth,
				maxWidth: 'calc(100vw - 2rem)',
				height: '70vh',
				maxHeight: 640,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
			}}
		>
			{/* Header */}
			<div
				className="flex items-center gap-2 px-3 py-2.5 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				<Brain
					className={`w-4 h-4 shrink-0 ${live ? 'animate-pulse' : ''}`}
					style={{ color: theme.colors.accent }}
				/>
				<div className="flex flex-col min-w-0 flex-1">
					<span
						className="text-xs font-semibold leading-tight"
						style={{ color: theme.colors.textMain }}
					>
						Thought Stream
					</span>
					<span
						className="text-2xs truncate leading-tight"
						style={{ color: theme.colors.textDim }}
						title={label}
					>
						{label} · {thoughtCount} thought{thoughtCount === 1 ? '' : 's'} · {actionCount} action
						{actionCount === 1 ? '' : 's'}
						{showToolActivity ? '' : ' hidden'}
						{trimmed ? ' (trimmed)' : ''}
						{live ? ' · live' : ''}
					</span>
				</div>
				<GhostIconButton
					onClick={toggleToolActivity}
					pressed={showToolActivity}
					title={
						showToolActivity
							? `Hide tool calls (${actionCount} captured - they keep buffering)`
							: `Show tool calls (${actionCount} captured while hidden)`
					}
					ariaLabel="Show tool calls"
					testId="thought-stream-tool-toggle"
					className="shrink-0"
					color={showToolActivity ? theme.colors.accent : theme.colors.textDim}
				>
					<Wrench className="w-3.5 h-3.5" />
				</GhostIconButton>
				<GhostIconButton
					onClick={() => clearBuffer(panelSessionId)}
					title="Discard buffered thoughts"
					ariaLabel="Discard buffered thoughts"
					className="shrink-0"
					color={theme.colors.textDim}
				>
					<Trash2 className="w-3.5 h-3.5" />
				</GhostIconButton>
				<GhostIconButton
					onClick={closePanel}
					title="Close (thoughts keep buffering)"
					ariaLabel="Close Thought Stream"
					className="shrink-0"
					color={theme.colors.textDim}
				>
					<X className="w-4 h-4" />
				</GhostIconButton>
			</div>

			{/* The bar: two labelled buttons at rest, the input either one opened
			    otherwise. Between runs there is nothing to steer, so it is the
			    search box alone. */}
			<div
				className="px-3 py-2 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
				data-testid="thought-stream-bar"
			>
				{bar === 'buttons' ? (
					<div className="flex gap-2">
						<button
							type="button"
							onClick={() => setBarMode('search')}
							className="flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium border transition-colors hover:bg-white/5"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
							title="Search the thought stream"
							data-testid="thought-stream-search-open"
						>
							<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
							<span className="truncate">
								{panelWidth < COMPACT_SEARCH_LABEL_WIDTH ? 'Search' : 'Search thought stream'}
							</span>
						</button>
						<button
							type="button"
							onClick={() => setBarMode('steer')}
							className="flex-1 min-w-0 flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-semibold border transition-colors hover:brightness-125"
							style={{
								backgroundColor: theme.colors.warning + '20',
								borderColor: theme.colors.warning,
								color: theme.colors.warning,
							}}
							title={steerButtonTitle}
							data-testid="thought-stream-steer-toggle"
						>
							<Compass className="w-3.5 h-3.5 shrink-0" />
							<span className="truncate">
								{panelWidth < COMPACT_STEER_LABEL_WIDTH ? 'Steer' : 'Steer Auto Run'}
							</span>
							{pendingNotes.length > 0 && (
								<CountBadge
									count={pendingNotes.length}
									theme={theme}
									label="pending steering note"
									style={{
										backgroundColor: theme.colors.warning + '33',
										border: `1px solid ${theme.colors.warning}66`,
										color: theme.colors.warning,
									}}
									data-testid="thought-stream-steer-pending-count"
								/>
							)}
						</button>
					</div>
				) : bar === 'steer' ? (
					// Sends on Enter, keeps the draft on Shift+Enter. The note does
					// not spawn a turn of its own - it rides in front of the next
					// task's prompt - so the placeholder says when it will be read
					// rather than leaving the operator to guess.
					<div data-testid="thought-stream-steer-composer">
						<div
							className="flex items-end gap-2 rounded border px-2 py-1.5"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.warning,
							}}
						>
							<Compass
								className="w-3.5 h-3.5 shrink-0 mb-1"
								style={{ color: theme.colors.warning }}
							/>
							<textarea
								ref={steerRef}
								value={steerDraft}
								onChange={(e) => setSteerDraft(e.target.value.slice(0, MAX_STEERING_NOTE_LENGTH))}
								onKeyDown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey) {
										e.preventDefault();
										sendSteeringNote();
										return;
									}
									// Escape belongs to the box while the caret is in it. The
									// layer handler would see the same key and reach the same
									// branch, but stopping here keeps the panel's Escape from
									// depending on which element happened to have focus.
									if (e.key === 'Escape') {
										e.preventDefault();
										e.stopPropagation();
										setBarMode('buttons');
									}
								}}
								// An empty box left behind goes back to the buttons: it
								// holds nothing, and it is hiding Search. A draft stays.
								onBlur={() => {
									if (!steerDraft.trim()) setBarMode('buttons');
								}}
								rows={1}
								placeholder="Steer the Auto Run - delivered at the start of the next task"
								className="flex-1 min-w-0 resize-none bg-transparent border-none outline-none text-xs leading-snug py-0.5 select-text scrollbar-thin"
								style={{ color: theme.colors.textMain }}
							/>
							<button
								type="button"
								onClick={sendSteeringNote}
								disabled={!steerDraft.trim()}
								className="flex items-center gap-1 px-2 py-1 rounded text-2xs font-medium transition-colors shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
								style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
								data-testid="thought-stream-steer-send"
							>
								<SendHorizonal className="w-3 h-3" />
								Send
							</button>
						</div>
						<div
							className="text-2xs mt-1.5"
							style={{ color: theme.colors.textDim }}
							data-shortcut-hint
						>
							Enter sends · Shift+Enter for a new line · Esc goes back
						</div>
					</div>
				) : (
					<div
						className="flex items-center gap-2 rounded px-2 py-1.5"
						style={{ backgroundColor: theme.colors.bgActivity }}
					>
						<Search className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
						<input
							ref={searchRef}
							type="text"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								// Same reasoning as the note box: while a run can be
								// steered, Escape here means "back to the buttons".
								if (e.key === 'Escape' && canSteer) {
									e.preventDefault();
									e.stopPropagation();
									leaveSearch();
								}
							}}
							// An empty search box left behind goes back to the buttons,
							// so Steer is never hidden behind an input holding nothing.
							onBlur={() => {
								if (!searching) setBarMode('buttons');
							}}
							placeholder="Search thought stream..."
							className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs"
							style={{ color: theme.colors.textMain }}
						/>
						{searching && (
							<button
								type="button"
								onClick={leaveSearch}
								className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
								title="Clear search"
								aria-label="Clear search"
							>
								<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
							</button>
						)}
						{canSteer && (
							// The way to steer without giving up a filter. Keeping the
							// press from blurring the input matters: an empty box would
							// swap back to the buttons between mousedown and mouseup,
							// and the click would land on nothing.
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => setBarMode('steer')}
								className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
								title={steerButtonTitle}
								aria-label="Steer the Auto Run"
								data-testid="thought-stream-steer-switch"
							>
								<Compass className="w-3.5 h-3.5" style={{ color: theme.colors.warning }} />
							</button>
						)}
					</div>
				)}
			</div>

			{/* What the operator has already said this run, and what came back.
			    Pending notes stay cancellable; delivered ones are grouped by the
			    task that took them, each group closing with that task's reply. The
			    strip grows while a reply is open - a whole task response does not
			    fit in the few lines the collapsed list is held to. */}
			{(pendingNotes.length > 0 || deliveries.length > 0) && (
				<div
					className="px-3 py-2 border-b shrink-0 flex flex-col gap-1.5 overflow-y-auto scrollbar-thin"
					style={{
						borderColor: theme.colors.border,
						maxHeight: deliveries.some((d) => d.deliveryId === expandedDeliveryId) ? '60%' : 120,
					}}
					data-testid="thought-stream-steer-notes"
				>
					{deliveries.map((delivery) => (
						<div key={delivery.deliveryId} className="flex flex-col gap-1.5">
							{delivery.notes.map((note) => (
								<SteeringNoteRow key={note.id} note={note} theme={theme} />
							))}
							<SteeringReply
								delivery={delivery}
								theme={theme}
								runInFlight={canSteer}
								expanded={expandedDeliveryId === delivery.deliveryId}
								onToggle={() =>
									setExpandedDeliveryId((open) =>
										open === delivery.deliveryId ? null : delivery.deliveryId
									)
								}
							/>
						</div>
					))}
					{pendingNotes.map((note) => (
						<SteeringNoteRow
							key={note.id}
							note={note}
							theme={theme}
							onCancel={() => cancelSteeringNote(panelSessionId, note.id)}
						/>
					))}
				</div>
			)}

			{/* Body */}
			<div
				ref={scrollRef}
				onScroll={(e) => {
					const el = e.currentTarget;
					stickToTopRef.current = el.scrollTop < 24;
				}}
				className="thought-stream-prose flex-1 overflow-y-auto px-3 py-2 scrollbar-thin select-text"
				style={{ color: theme.colors.textMain }}
			>
				<style>{proseStyles}</style>
				{visibleFeed.length === 0 ? (
					<p className="text-xs italic mt-2" style={{ color: theme.colors.textDim }}>
						{searching
							? 'Nothing matches your search.'
							: // An empty feed with actions in the buffer is the toggle's
								// doing, not an idle agent. Saying "nothing captured yet"
								// there would be a flat lie about a run that is working.
								hiddenActionsOnly
								? `${actionCount} tool call${actionCount === 1 ? '' : 's'} captured and hidden. Turn tool calls back on to read them.`
								: 'Nothing captured yet. Thinking and tool calls are buffered as the agent works, so this fills in on its own.'}
					</p>
				) : (
					<div className="flex flex-col gap-3">
						{visibleFeed.map((item) =>
							item.kind === 'tool' ? (
								<ToolActivityRow
									key={item.activity.id}
									activity={item.activity}
									theme={theme}
									query={searching ? query : ''}
								/>
							) : (
								<div key={item.block.id}>
									<div
										className="text-2xs font-mono mb-1 select-none"
										style={{ color: theme.colors.textDim }}
										title={new Date(item.block.startTimestamp).toLocaleString()}
									>
										{formatThoughtTime(item.block.startTimestamp)}
									</div>
									<div
										className="prose max-w-none break-words"
										style={{ fontSize: '0.75rem', color: theme.colors.textMain }}
									>
										<Markdown
											preset="document"
											content={item.block.text}
											theme={theme}
											frontmatter={false}
											searchHighlight={
												searching ? { query: query.trim(), currentMatchIndex: -1 } : undefined
											}
										/>
									</div>
								</div>
							)
						)}
					</div>
				)}
			</div>

			{searching && (
				<div
					className="px-3 py-1.5 border-t text-2xs shrink-0"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					{visibleFeed.length} of {feed.length} entr{feed.length === 1 ? 'y' : 'ies'} match
				</div>
			)}
		</div>
	);
}
