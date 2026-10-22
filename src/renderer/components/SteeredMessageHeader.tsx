/**
 * SteeredMessageHeader - the bar at the TOP of a user bubble that was steered
 * into a turn already running, and the connector that stitches that bubble to
 * the turn above it.
 *
 * A steered message never starts a turn of its own, so without a mark it reads
 * as an ordinary message the agent ignored until the turn ended. The header says
 * what it was, and - because a steer is answered twice (see SteeringVerdict in
 * src/shared/chatSteering.ts) - what the agent did with it:
 *
 *   - `pending`   typed into the turn; the transcript has not answered yet.
 *   - `absorbed`  the running turn took it and changed course. The only state
 *                 that earns the check.
 *   - `queued`    the agent could not fold it in and took it as a follow-up turn.
 *                 The verdict lands when that turn STARTS, so the label says
 *                 "sent", never "answered": the reply may not exist yet.
 *                 Muted, and drawn WITHOUT the connector: it did not join the
 *                 turn, so stitching it there would say the opposite.
 *   - absent      steered before the state was recorded. Says "Steered" and
 *                 claims no outcome.
 *
 * Whether the bubble is stitched is `steerJoinsRunningTurn()` in
 * src/renderer/utils/logEntries.ts, so the row and its neighbor agree.
 */

import { Check, Navigation } from 'lucide-react';
import { Spinner } from './ui/Spinner';
import type { Theme } from '../types';
import type { SteerBubbleState } from '../../shared/chatSteering';

interface SteerBubbleCopy {
	label: string;
	/** Hover text: the same fact as the label, in a full sentence. */
	title: string;
}

const STEER_BUBBLE_COPY: Record<SteerBubbleState | 'unrecorded', SteerBubbleCopy> = {
	pending: {
		label: 'Steering the running turn',
		title: 'Typed into the turn that was already running. Waiting for the agent to take it.',
	},
	absorbed: {
		label: 'Steered into the running turn',
		title: 'The turn that was already running took this message and changed course.',
	},
	queued: {
		label: 'Sent as a follow-up',
		title:
			'The agent could not fold this into the turn that was already running, so it took it as a follow-up turn once that one ended.',
	},
	unrecorded: {
		label: 'Steered',
		title: 'Sent as a steer into the turn that was already running',
	},
};

/** The header's label and hover text for a steer in `state`. */
export function steerBubbleCopy(state: SteerBubbleState | undefined): SteerBubbleCopy {
	return STEER_BUBBLE_COPY[state ?? 'unrecorded'];
}

/** Height of the header bar, in px. The connector's elbow lands on its middle. */
const HEADER_HEIGHT = 28;
/** The row's `py-2`: how far above the bubble the connector starts. */
const ROW_PADDING = 8;
/** From the top of the row to the header's middle, past the bubble's 1px border. */
const ELBOW_HEIGHT = ROW_PADDING + 1 + HEADER_HEIGHT / 2;

export interface SteeredMessageHeaderProps {
	state: SteerBubbleState | undefined;
	theme: Theme;
	/**
	 * The turns that took the message, when there can be more than one (a group
	 * chat round). Names them in the label instead of "the running turn".
	 */
	targets?: readonly string[];
}

export function SteeredMessageHeader({
	state,
	theme,
	targets,
}: SteeredMessageHeaderProps): JSX.Element {
	const copy = steerBubbleCopy(state);
	const named = targets && targets.length > 0 ? targets.join(', ') : null;
	const label = named ? `Steered to ${named}` : copy.label;
	const title = named
		? `Typed into the round that was already running. Taken by: ${named}.`
		: copy.title;
	// A follow-up did not steer anything, so it does not wear the Steer accent.
	const tint = state === 'queued' ? theme.colors.textDim : theme.colors.accent;

	return (
		<div
			// Full-bleed bar: negative margins break out of the bubble's p-4 so the
			// header sits flush against the (overflow-hidden, rounded) top edge.
			className="-mx-4 -mt-4 mb-3 flex items-center gap-1.5 px-3 border-b select-none"
			style={{
				height: HEADER_HEIGHT,
				backgroundColor: `color-mix(in srgb, ${tint} 14%, transparent)`,
				borderColor: `color-mix(in srgb, ${tint} 30%, ${theme.colors.border})`,
				color: tint,
			}}
			title={title}
			data-testid="steered-message-header"
			data-steer-state={state ?? 'unrecorded'}
		>
			{/* Same icon as the Steer button on a queued card. */}
			<Navigation className="w-3 h-3 shrink-0" aria-hidden />
			<span className="min-w-0 truncate text-2xs font-semibold uppercase tracking-wide">
				{label}
			</span>
			{state === 'pending' && (
				<Spinner size={11} color={tint} decorative testId="steered-message-spinner" />
			)}
			{state === 'absorbed' && (
				<Check
					className="w-3.5 h-3.5 shrink-0"
					style={{ color: theme.colors.success }}
					aria-hidden
				/>
			)}
		</div>
	);
}

export interface SteerTurnConnectorProps {
	theme: Theme;
	/** The bubble sits on the left of the row, so the connector hangs off its right. */
	mirrored: boolean;
	/** The next entry is stitched to the same turn, so the line runs on down to it. */
	continues: boolean;
}

/**
 * The line from the entry above down to a steered bubble's header: drawn in the
 * indent between the timestamp column and the bubble, as a sibling of both.
 *
 * It lives INSIDE its own row because rows are `content-visibility: auto`, which
 * clips paint to the row's box; the row pulls itself up over the previous row's
 * bottom padding so the line still starts at the bubble above. Hidden on a phone,
 * where the row stacks and there is no gutter to draw in.
 */
export function SteerTurnConnector({
	theme,
	mirrored,
	continues,
}: SteerTurnConnectorProps): JSX.Element {
	const borderColor = theme.colors.accent + 'AA';
	const side = mirrored ? 'right-3' : 'left-3';
	return (
		<div
			aria-hidden
			// The negative margin cancels the row's gap on the bubble side, so the
			// bubble starts where this ends and the indent is exactly this width.
			className={`hidden sm:block relative shrink-0 w-7 ${mirrored ? '-ml-4' : '-mr-4'}`}
			data-testid="steer-turn-connector"
		>
			{continues ? (
				<>
					{/* A junction, not an elbow: the line carries on to the next steer. */}
					<div
						className={`absolute -top-2 -bottom-2 ${side} ${mirrored ? 'border-r' : 'border-l'}`}
						style={{ borderColor }}
					/>
					<div
						className={`absolute border-t ${mirrored ? 'left-0 right-3' : 'left-3 right-0'}`}
						style={{ top: ELBOW_HEIGHT - ROW_PADDING, borderColor }}
					/>
				</>
			) : (
				<div
					className={`absolute -top-2 border-b ${
						mirrored
							? 'left-0 right-3 border-r rounded-br-lg'
							: 'left-3 right-0 border-l rounded-bl-lg'
					}`}
					style={{ height: ELBOW_HEIGHT, borderColor }}
				/>
			)}
		</div>
	);
}

export default SteeredMessageHeader;
