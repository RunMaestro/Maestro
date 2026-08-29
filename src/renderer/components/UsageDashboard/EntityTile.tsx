/**
 * EntityTile - the compact stat tile used by the Usage Dashboard's card grids.
 *
 * One shape: a status dot, a title, optional badges, a corner age, an optional
 * secondary line, a row of labeled stats, and a sparkline. It carries the
 * chrome - border states, hover/selected promotion, the staggered enter
 * animation, the highlighted-stat coloring - so a card grid does not re-derive
 * it. The agent grid (`AgentOverviewCards`) is the current consumer; the
 * per-agent tab breakdown reads as a list instead, since its rows are narrow
 * enough that a table scans better than a second wall of tiles.
 *
 * Purely presentational: it takes formatted strings and colors, and reports
 * clicks. Callers own their own data shaping and sort/filter state.
 */

import { memo, useState } from 'react';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { Sparkline } from './Sparkline';

/** Per-tile delay of the staggered entrance, in ms. */
const STAGGER_STEP_MS = 60;
/**
 * Cap on how many tiles the stagger walks before every later tile shares the
 * final delay. Both grids can render far more tiles than the effect was
 * designed around - an agent with a hundred entries would otherwise leave the
 * last card blank for six seconds, and an unpaginated tab list was worse - so
 * the ramp stops here and the tail animates together.
 */
const STAGGER_MAX_STEPS = 12;

/**
 * Per-size layout tokens.
 *
 * `lg` exists for the group grid. A group is a container of agents, so its tile
 * is deliberately bigger than an agent's - the size difference is the visual
 * cue for the containment relationship, not decoration.
 *
 * The stat layout is the substantive part. The default tile packs stats into a
 * single flex row, which works for three short values but collides once a tile
 * carries four (a group's queries + time + tokens + cost ran together as
 * "79.5M$65.99"). The large tile lays them out in a wrapping grid instead, so
 * adding a stat reflows rather than overlaps.
 */
const SIZE_TOKENS = {
	default: {
		container: 'p-3 gap-1.5',
		title: 'text-sm',
		subtitle: 'text-[11px]',
		statLabel: 'text-[9px]',
		statValue: 'text-base',
		statLayout: 'flex items-end gap-3',
		sparkline: { width: 70, height: 22 },
	},
	lg: {
		container: 'p-4 gap-2',
		title: 'text-base',
		subtitle: 'text-xs',
		statLabel: 'text-[10px]',
		statValue: 'text-xl',
		// auto-fit rather than a fixed column count: three stats stay on one
		// row, four wrap to 2x2, and neither has to be special-cased here.
		//
		// The 104px floor is what stops a value being clipped rather than the
		// tile width alone - a cell narrower than this truncated "142h 5m" to
		// "142h 5…" even inside a roomy tile, because the column, not the card,
		// is what a stat value has to fit into.
		statLayout: 'grid gap-x-4 gap-y-2 grid-cols-[repeat(auto-fit,minmax(104px,1fr))]',
		sparkline: { width: 96, height: 30 },
	},
} as const;

/** Tile scale. `lg` is the group grid; `default` is everything else. */
export type EntityTileSize = keyof typeof SIZE_TOKENS;

/** One labeled number in the tile's stat row. */
export interface EntityTileStat {
	/** Short uppercase label, e.g. "Queries". Also used as the React key. */
	label: string;
	/** Pre-formatted value. Use an em-dash for "no data" rather than a bare 0. */
	value: string;
	/** When true, the label and value take the accent color. Used to show which
	 *  stat the grid is currently sorted by. */
	highlighted?: boolean;
	/** Renders the value dim rather than in the main text color. For values that
	 *  are absent rather than zero. */
	muted?: boolean;
	/** Tooltip for the value. */
	title?: string;
	/** Test id for the value element. */
	testId?: string;
}

/** A small pill rendered to the right of the title, e.g. the "WT" worktree flag. */
export interface EntityTileBadge {
	label: string;
	title?: string;
	testId?: string;
	/** Defaults to the theme accent. */
	color?: string;
}

export interface EntityTileProps {
	theme: Theme;
	/** Tile title. Truncates; the full string is the tooltip. */
	title: string;
	/** Color of the leading status dot. Omit to hide the dot entirely. */
	statusColor?: string;
	/** Pulse the status dot. Reserved for genuinely in-progress work. */
	statusPulsing?: boolean;
	/** Short right-aligned age, e.g. "3mo". */
	age?: string;
	/** Tooltip for the age. */
	ageTitle?: string;
	/** Accent the age (it is the active sort key). */
	ageHighlighted?: boolean;
	badges?: EntityTileBadge[];
	/** Dim secondary line under the title, e.g. a worktree's branch. */
	subtitle?: string;
	subtitleTestId?: string;
	stats: EntityTileStat[];
	/** Sparkline series, oldest to newest. Omit to leave the corner empty. */
	sparkline?: number[];
	sparklineColor?: string;
	/** 0-based index for the staggered card-enter animation. The ramp is capped
	 *  at `STAGGER_MAX_STEPS`, so a large grid does not leave late tiles blank. */
	animationIndex: number;
	/** Render with a 2px accent border to flag the active drill-down filter. */
	isSelected?: boolean;
	/** Render with a dashed border, e.g. for worktree agents. Suppressed while
	 *  selected or hovered, since those borders outrank it. */
	isDashed?: boolean;
	/** Makes the tile a button with a hover affordance. */
	onClick?: () => void;
	/** Tile scale. `lg` enlarges type and spacing and switches the stat row to a
	 *  wrapping grid. Used by the group grid so a container of agents reads as
	 *  larger than the agents inside it. */
	size?: EntityTileSize;
	/** Full accessible label. Callers build this since only they know the units. */
	ariaLabel: string;
	testId: string;
	/** Marks the tile as the current drill-down selection for tests. */
	selectedTestValue?: string;
}

export const EntityTile = memo(function EntityTile({
	theme,
	title,
	statusColor,
	statusPulsing = false,
	age,
	ageTitle,
	ageHighlighted = false,
	badges,
	subtitle,
	subtitleTestId,
	stats,
	sparkline,
	sparklineColor,
	animationIndex,
	isSelected = false,
	isDashed = false,
	onClick,
	size = 'default',
	ariaLabel,
	testId,
}: EntityTileProps) {
	const tokens = SIZE_TOKENS[size];
	const [isHovered, setIsHovered] = useState(false);
	const isClickable = Boolean(onClick);

	// When a drill-down filter selects this tile, the 1px default border is
	// replaced with a 2px solid accent border. Dashing is suppressed for the
	// duration - the highlight outranks it, and the badge keeps the distinction
	// visible. While hovered (clickable tiles only), the border is promoted to
	// the accent color so the tile reads as actionable.
	const border = isSelected
		? `2px solid ${theme.colors.accent}`
		: isHovered && isClickable
			? `1px solid ${theme.colors.accent}`
			: isDashed
				? `1px dashed ${theme.colors.accent}99`
				: `1px solid ${theme.colors.border}`;
	const backgroundColor =
		isHovered && isClickable ? `${theme.colors.accent}12` : theme.colors.bgActivity;

	const handleKeyDown = onClick
		? (e: React.KeyboardEvent<HTMLDivElement>) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					onClick();
				}
			}
		: undefined;

	return (
		<div
			className={`card-enter relative rounded-lg flex flex-col transition-colors ${tokens.container} ${
				isClickable ? 'cursor-pointer focus:outline-none focus-visible:ring-2' : ''
			}`}
			style={{
				backgroundColor,
				border,
				animationDelay: `${Math.min(animationIndex, STAGGER_MAX_STEPS) * STAGGER_STEP_MS}ms`,
				transitionDuration: '120ms',
				...(isClickable ? ({ '--tw-ring-color': theme.colors.accent } as React.CSSProperties) : {}),
			}}
			data-testid={testId}
			data-size={size}
			data-selected={isSelected ? 'true' : undefined}
			data-clickable={isClickable ? 'true' : undefined}
			role={isClickable ? 'button' : 'group'}
			tabIndex={isClickable ? 0 : undefined}
			onClick={onClick}
			onKeyDown={handleKeyDown}
			onMouseEnter={isClickable ? () => setIsHovered(true) : undefined}
			onMouseLeave={isClickable ? () => setIsHovered(false) : undefined}
			aria-label={ariaLabel}
		>
			<div className="flex items-center gap-2 min-w-0">
				{statusColor && (
					<span
						className="flex-shrink-0 w-2 h-2 rounded-full"
						style={{
							backgroundColor: statusColor,
							animation: statusPulsing ? 'status-pulse 1.4s ease-in-out infinite' : undefined,
						}}
						aria-hidden="true"
						data-testid={`${testId}-status-dot`}
					/>
				)}
				<span
					className={`${tokens.title} font-medium truncate flex-1 min-w-0`}
					style={{ color: theme.colors.textMain }}
					title={title}
				>
					{title}
				</span>
				{badges?.map((badge) => (
					<MiniBadge
						key={badge.label}
						label={badge.label}
						theme={theme}
						color={badge.color}
						title={badge.title}
						testId={badge.testId}
					/>
				))}
				{age && (
					<span
						className="flex-shrink-0 text-[10px] tabular-nums"
						style={{
							color: ageHighlighted ? theme.colors.accent : theme.colors.textDim,
							fontWeight: ageHighlighted ? 600 : undefined,
						}}
						title={ageTitle}
						data-testid={`${testId}-age`}
						data-highlighted={ageHighlighted ? 'true' : undefined}
					>
						{age}
					</span>
				)}
			</div>
			{subtitle && (
				<div
					className={`${tokens.subtitle} truncate`}
					style={{ color: theme.colors.textDim }}
					title={subtitle}
					data-testid={subtitleTestId}
				>
					{subtitle}
				</div>
			)}
			<div className="flex items-end justify-between gap-3 mt-auto">
				<div className={`${tokens.statLayout} min-w-0 flex-1`}>
					{stats.map((stat) => (
						<div key={stat.label} className="flex flex-col min-w-0">
							<span
								className={`${tokens.statLabel} uppercase tracking-wide`}
								style={{
									color: stat.highlighted ? theme.colors.accent : theme.colors.textDim,
								}}
							>
								{stat.label}
							</span>
							<span
								className={`${tokens.statValue} font-semibold truncate tabular-nums`}
								style={{
									color:
										stat.highlighted && !stat.muted
											? theme.colors.accent
											: stat.muted
												? theme.colors.textDim
												: theme.colors.textMain,
								}}
								data-testid={stat.testId}
								data-highlighted={stat.highlighted ? 'true' : undefined}
								title={stat.title}
							>
								{stat.value}
							</span>
						</div>
					))}
				</div>
				{sparkline && (
					<div className="flex-shrink-0 opacity-80 pointer-events-none">
						<Sparkline
							data={sparkline}
							color={sparklineColor ?? theme.colors.accent}
							width={tokens.sparkline.width}
							height={tokens.sparkline.height}
						/>
					</div>
				)}
			</div>
		</div>
	);
});

export default EntityTile;
