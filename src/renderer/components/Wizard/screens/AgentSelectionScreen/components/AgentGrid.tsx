import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useElementWidth, useHorizontalScroll } from '../../../../../hooks/ui';
import { ProviderAvailabilityBar } from '../../../../ui/ProviderAvailabilityBar';
import type { AgentConfig, Theme } from '../../../../../types';
import type { AgentTile } from '../types';
import { isAgentAvailable } from '../utils/agentAvailability';
import { resolveAgentGridLayout } from '../utils/agentGridLayout';
import { AgentTileButton } from './AgentTileButton';

/**
 * Width of the fade-plus-arrow overlay at each end of the strip.
 *
 * The overlays float over the strip's own edges, so a tile scrolled flush to an
 * edge comes to rest underneath one and reads as still off-screen. Keeping this
 * much clear on both sides is what makes arrow-key movement look like it landed.
 */
const STRIP_EDGE_PADDING_PX = 64;

interface AgentGridProps {
	theme: Theme;
	tiles: AgentTile[];
	detectedAgents: AgentConfig[];
	selectedAgent: string | null;
	focusedTileIndex: number;
	isNameFieldFocused: boolean;
	totalProviderCount: number;
	availableProviderCount: number;
	/** Follows "available" in the summary line - "locally" or "on <host>". */
	providerLocationLabel: string;
	showAllProviders: boolean;
	tileRefs: RefObject<(HTMLButtonElement | null)[]>;
	onTileClick: (tile: AgentTile, index: number) => void;
	onOpenConfig: (agentId: string) => void;
	onShowAllProvidersChange: (showAll: boolean) => void;
	/**
	 * Reports how many tiles ended up in a row, so the screen's arrow-key handler
	 * moves by the layout that was actually drawn rather than by an assumed one.
	 */
	onColumnsChange?: (columns: number) => void;
	setFocusedTileIndex: (index: number) => void;
	setIsNameFieldFocused: (focused: boolean) => void;
}

/**
 * The provider tiles, in whichever of the two shapes the count calls for.
 *
 * Every supported provider no longer fits above the Continue button, so the
 * full list is a single horizontally scrolling row - which needs to say out
 * loud that there is more past the right edge, hence the edge fades, the arrow
 * buttons, and the provider count. A list short enough for two rows (the usual
 * case once the user filters to what is installed) drops the strip and draws a
 * centered wrapping block instead: a few tiles pinned to the left edge of a
 * wide scrolling row reads as a layout that forgot to reflow.
 */
export function AgentGrid({
	theme,
	tiles,
	detectedAgents,
	selectedAgent,
	focusedTileIndex,
	isNameFieldFocused,
	totalProviderCount,
	availableProviderCount,
	providerLocationLabel,
	showAllProviders,
	tileRefs,
	onTileClick,
	onOpenConfig,
	onShowAllProvidersChange,
	onColumnsChange,
	setFocusedTileIndex,
	setIsNameFieldFocused,
}: AgentGridProps): JSX.Element {
	// Measured on the OUTER wrapper, which spans the full available width. The
	// wrapping block caps its own width to force the row break, so measuring that
	// element instead would feed its own cap back in and shrink it every pass.
	const measureRef = useRef<HTMLDivElement>(null);
	const containerWidth = useElementWidth(measureRef);
	const layout = useMemo(
		() => resolveAgentGridLayout(tiles.length, containerWidth),
		[tiles.length, containerWidth]
	);

	// The mode is part of the reset key, not just the tile count: a resize can
	// swap the strip in without the count moving, and the scroll hook only picks
	// up a freshly mounted element when this changes.
	const stripRef = useRef<HTMLDivElement>(null);
	const { canScrollLeft, canScrollRight, scrollByPage, scrollIntoView } = useHorizontalScroll(
		stripRef,
		`${layout.mode}:${tiles.length}`
	);

	useEffect(() => {
		onColumnsChange?.(layout.columns);
	}, [layout.columns, onColumnsChange]);

	// Keep the focus ring on screen. This tracks `focusedTileIndex` rather than
	// DOM focus because a disabled tile (an uninstalled provider, visible when the
	// filter is off) never takes focus - the ring still moves onto it, so the
	// strip has to move with the ring or arrowing across one looks like a freeze.
	useEffect(() => {
		if (isNameFieldFocused) return;
		// Read the ref inside the effect, not during render: ref callbacks run at
		// commit, so on the render that first mounts a tile the array is still empty
		// and a render-time read would capture null with no re-render to correct it.
		scrollIntoView(tileRefs.current?.[focusedTileIndex], STRIP_EDGE_PADDING_PX);
	}, [focusedTileIndex, isNameFieldFocused, scrollIntoView, tileRefs, tiles]);

	const renderTile = (tile: AgentTile, index: number): JSX.Element => (
		<AgentTileButton
			key={tile.id}
			tile={tile}
			index={index}
			theme={theme}
			isDetected={isAgentAvailable(detectedAgents, tile.id)}
			isSelected={selectedAgent === tile.id}
			isFocused={focusedTileIndex === index && !isNameFieldFocused}
			onTileClick={onTileClick}
			onOpenConfig={onOpenConfig}
			onFocusTile={(tileIndex) => {
				setFocusedTileIndex(tileIndex);
				setIsNameFieldFocused(false);
			}}
			setTileRef={(tileIndex, element) => {
				if (tileRefs.current) {
					tileRefs.current[tileIndex] = element;
				}
			}}
		/>
	);

	return (
		<div className="flex flex-col items-center gap-3 w-full min-w-0">
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				Select the provider that will power your agent.
			</p>

			<ProviderAvailabilityBar
				theme={theme}
				availableCount={availableProviderCount}
				totalCount={totalProviderCount}
				locationLabel={providerLocationLabel}
				showAll={showAllProviders}
				onShowAllChange={onShowAllProvidersChange}
			/>

			<div ref={measureRef} className="w-full min-w-0 flex justify-center">
				{layout.mode === 'wrap' ? (
					<div
						className="flex flex-wrap justify-center gap-4 px-1 py-1"
						style={{ maxWidth: layout.maxWidthPx }}
						role="group"
						aria-label="Available providers"
					>
						{tiles.map(renderTile)}
					</div>
				) : (
					/*
						The strip deliberately carries no `scroll-smooth`: that class applies
						to EVERY programmatic scroll, including the browser's own
						scroll-into-view when arrow-key focus lands on an off-screen tile and
						the per-tick writes a wheel gesture makes, turning each one into a
						fresh eased animation that trails the input. The arrow buttons ask for
						smooth explicitly instead.
					*/
					<div className="relative w-full max-w-5xl min-w-0">
						<div
							ref={stripRef}
							className="flex gap-4 overflow-x-auto no-scrollbar px-1 py-1"
							role="group"
							aria-label="Available providers"
						>
							{tiles.map(renderTile)}
						</div>

						<StripEdge
							theme={theme}
							side="left"
							visible={canScrollLeft}
							onScroll={() => scrollByPage('left')}
						/>
						<StripEdge
							theme={theme}
							side="right"
							visible={canScrollRight}
							onScroll={() => scrollByPage('right')}
						/>
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Fade plus arrow button at one end of the strip.
 *
 * Kept out of the tab order: the strip is driven with the left/right arrow keys
 * and Tab is already spoken for (it moves to the agent name field), so adding
 * two more tab stops here would put dead ends in the middle of that path.
 */
function StripEdge({
	theme,
	side,
	visible,
	onScroll,
}: {
	theme: Theme;
	side: 'left' | 'right';
	visible: boolean;
	onScroll: () => void;
}): JSX.Element {
	const isLeft = side === 'left';
	const Icon = isLeft ? ChevronLeft : ChevronRight;

	return (
		<div
			className={`absolute top-0 bottom-0 flex items-center transition-opacity duration-200 ${
				isLeft ? 'left-0 pl-1 justify-start' : 'right-0 pr-1 justify-end'
			} ${visible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
			style={{
				width: `${STRIP_EDGE_PADDING_PX}px`,
				background: `linear-gradient(to ${isLeft ? 'right' : 'left'}, ${theme.colors.bgMain}, ${theme.colors.bgMain}00)`,
			}}
			aria-hidden="true"
		>
			<button
				type="button"
				tabIndex={-1}
				onClick={onScroll}
				className="flex items-center justify-center w-8 h-8 rounded-full border transition-colors hover:bg-white/10"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
				}}
				title={isLeft ? 'Scroll left' : 'Scroll right'}
			>
				<Icon className="w-4 h-4" />
			</button>
		</div>
	);
}
