import type { Theme } from '../../../types';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import type { MarkerStatus, ScannedMarker } from '../../../../shared/autorunMarkers';
import { HoverTooltip } from '../../ui/HoverTooltip';

interface MarkerPillProps {
	kind: ScannedMarker['kind'];
	status: MarkerStatus;
	scope: ScannedMarker['scope'];
	/** What the marker does, already phrased for a reader. */
	label: string;
	/** The reason a human is needed, or the attribute value that was misspelled. */
	detail?: string;
	/** HITL only: what the human should go look at. */
	artifact?: string;
	/** Model only: why the author picked this tier and effort. Shown on hover. */
	reason?: string;
	theme: Theme;
}

/** Cap for the hover overlay, wide enough for a few sentences without becoming a page. */
const REASON_OVERLAY_MAX_WIDTH = 320;

/**
 * The visible form of an Auto Run marker in a rendered document.
 *
 * Maestro's markers are HTML comments, so they render as nothing - which is
 * correct for the file and wrong for the reader. Two of the three do not just
 * change the next run, they stop it: a live HITL gate pauses every re-run until
 * a box is ticked, and a halt marker makes Auto Run refuse to start. Both of
 * those failures present as "I pressed Run and nothing happened", with the
 * cause sitting in text the panel does not draw.
 *
 * The pill states the EFFECT, not the marker name: "Pauses here" rather than
 * "HITL". Someone reading a playbook for the first time should not need to have
 * learned the vocabulary to understand why their run stopped.
 *
 * Color follows the five-color language used elsewhere in Maestro, chosen by
 * what the marker will do rather than by which marker it is:
 *
 * - **error** - a halt. The run will not start.
 * - **warning** - a live gate, or an unparseable setting. Something needs a person.
 * - **accent** - a model hint that governs the next dispatch, or a later one.
 * - **dim** - anything spent. Present in the file, doing nothing.
 *
 * A model hint that has not been reached yet keeps the accent hue and loses
 * some weight, rather than going dim. Dim is reserved for markers that are over
 * with, and a hint on a phase the run has yet to reach is the opposite of that:
 * it is the setting that phase is going to be dispatched at. Drawing the two
 * the same way made an upcoming `high` phase read as expired.
 *
 * Both foreground and background derive from theme colors, so the text runs
 * through `readableTextOn` - a theme whose warning sits near its background
 * would otherwise paint near-invisible text on a tinted chip.
 */
export function MarkerPill({
	kind,
	status,
	scope,
	label,
	detail,
	artifact,
	reason,
	theme,
}: MarkerPillProps) {
	const spent = status === 'spent';
	const upcoming = status === 'upcoming';
	const baseColor = spent
		? theme.colors.textDim
		: kind === 'halt'
			? theme.colors.error
			: kind === 'hitl' || status === 'invalid'
				? theme.colors.warning
				: theme.colors.accent;

	const background = transparentize(baseColor, theme.colors.bgMain, 0.14);
	const textColor = readableTextOn(baseColor, [background, theme.colors.bgMain]);
	const borderColor = transparentize(baseColor, theme.colors.bgMain, 0.4);

	// A spent marker is history: it should be legible when looked for and never
	// compete with the live one three lines below it. An upcoming one sits
	// between the two - real, but not what the run is about to do.
	const opacity = spent ? 0.65 : upcoming ? 0.8 : 1;

	const title = [
		detail,
		artifact ? `Artifact: ${artifact}` : undefined,
		spent ? 'This marker is no longer affecting the run.' : undefined,
		upcoming ? 'This applies to a later task, not the next one.' : undefined,
	]
		.filter(Boolean)
		.join('\n');

	return (
		<span
			data-testid={`maestro-marker-${kind}`}
			data-marker-status={status}
			// Announced as one unit so a screen reader gets "Pauses here, Add the
			// API key" rather than two unrelated fragments.
			role="note"
			// The reason rides the label rather than the `title` below, so a screen
			// reader and a keyboard user both get it without the hover overlay, and
			// so the native tooltip does not fire underneath that overlay.
			aria-label={`${label}${detail ? `: ${detail}` : ''}${reason ? `. ${reason}` : ''}`}
			title={title || undefined}
			style={{
				display: 'inline-flex',
				alignItems: 'baseline',
				gap: '0.375em',
				// `em` throughout so the pill tracks the reading pane's font scale
				// rather than staying fixed while the prose around it grows.
				padding: '0.1em 0.5em',
				borderRadius: '999px',
				border: `1px solid ${borderColor}`,
				backgroundColor: background,
				color: textColor,
				fontSize: '0.8em',
				fontWeight: 600,
				lineHeight: 1.5,
				opacity,
				// A standalone marker owns its line; an inline one trails the task
				// text and needs to be pushed off the last word.
				marginLeft: scope === 'task' ? '0.5em' : undefined,
				verticalAlign: 'baseline',
				whiteSpace: 'nowrap',
			}}
		>
			<span aria-hidden="true">
				{kind === 'halt' ? '■' : kind === 'hitl' ? (spent ? '✓' : '⏸') : '◆'}
			</span>
			<span>{label}</span>
			{detail && scope !== 'task' && (
				<span
					style={{
						fontWeight: 400,
						opacity: 0.85,
						// The reason can be a full sentence; the label must not be
						// pushed off screen by it.
						whiteSpace: 'normal',
					}}
				>
					{detail}
				</span>
			)}
			{/*
			 * Why this model, behind a peek rather than in the pill.
			 *
			 * The justification is the author's reasoning, not a setting, and it is
			 * the same length as the task it sits beside - inlining it would double
			 * the height of every hinted line and bury the task list it is meant to
			 * annotate. It also has to work at task scope, where the pill trails the
			 * task text on one `nowrap` line and there is nowhere to put a sentence.
			 * A portaled overlay solves both: the reason is one hover away at either
			 * scope, and the document still reads as a document.
			 */}
			{reason && (
				<HoverTooltip
					label={reason}
					theme={theme}
					maxWidth={REASON_OVERLAY_MAX_WIDTH}
					triggerClassName="inline-flex"
					triggerStyle={{ cursor: 'help', alignItems: 'center' }}
				>
					{/*
					 * The empty `title` is load-bearing: without it the pill's own
					 * `title` tooltip is inherited here and fires underneath the
					 * overlay, showing the reader two boxes at once.
					 */}
					<span
						data-testid="maestro-marker-reason"
						title=""
						aria-hidden="true"
						style={{ opacity: 0.75, fontWeight: 400 }}
					>
						ⓘ
					</span>
				</HoverTooltip>
			)}
		</span>
	);
}
