import type { Theme } from '../../../types';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';
import type { MarkerStatus, ScannedMarker } from '../../../../shared/autorunMarkers';

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
	theme: Theme;
}

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
 * - **accent** - a live model hint. Informational; the run proceeds.
 * - **dim** - anything spent. Present in the file, doing nothing.
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
	theme,
}: MarkerPillProps) {
	const spent = status === 'spent';
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
	// compete with the live one three lines below it.
	const opacity = spent ? 0.65 : 1;

	const title = [
		detail,
		artifact ? `Artifact: ${artifact}` : undefined,
		spent ? 'This marker is no longer affecting the run.' : undefined,
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
			aria-label={`${label}${detail ? `: ${detail}` : ''}`}
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
		</span>
	);
}
