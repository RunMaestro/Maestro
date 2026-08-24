import { useRef, type RefObject } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useHorizontalScroll } from '../../../../../hooks/ui';
import type { AgentConfig, Theme } from '../../../../../types';
import type { AgentTile } from '../types';
import { isAgentAvailable } from '../utils/agentAvailability';
import { AgentTileButton } from './AgentTileButton';

interface AgentGridProps {
	theme: Theme;
	tiles: AgentTile[];
	detectedAgents: AgentConfig[];
	selectedAgent: string | null;
	focusedTileIndex: number;
	isNameFieldFocused: boolean;
	tileRefs: RefObject<(HTMLButtonElement | null)[]>;
	onTileClick: (tile: AgentTile, index: number) => void;
	onOpenConfig: (agentId: string) => void;
	setFocusedTileIndex: (index: number) => void;
	setIsNameFieldFocused: (focused: boolean) => void;
}

/**
 * The provider strip: one horizontally scrolling row of tiles.
 *
 * A wrapping grid stopped working once the provider count passed eight - a
 * third row pushed the Continue button below the fold. A single row keeps the
 * screen's shape fixed no matter how many providers ship, at the cost of
 * needing to say out loud that there is more past the right edge, which is what
 * the edge fades and the arrow buttons are for.
 */
export function AgentGrid({
	theme,
	tiles,
	detectedAgents,
	selectedAgent,
	focusedTileIndex,
	isNameFieldFocused,
	tileRefs,
	onTileClick,
	onOpenConfig,
	setFocusedTileIndex,
	setIsNameFieldFocused,
}: AgentGridProps): JSX.Element {
	const stripRef = useRef<HTMLDivElement>(null);
	const { canScrollLeft, canScrollRight, scrollByPage } = useHorizontalScroll(
		stripRef,
		tiles.length
	);

	return (
		<div className="flex flex-col items-center gap-4 w-full min-w-0">
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				Select the provider that will power your agent.
			</p>

			{/*
				The strip deliberately carries no `scroll-smooth`: that class applies to
				EVERY programmatic scroll, including the browser's own scroll-into-view
				when arrow-key focus lands on an off-screen tile and the per-tick writes
				a wheel gesture makes, turning each one into a fresh eased animation that
				trails the input. The arrow buttons ask for smooth explicitly instead.
			*/}
			<div className="relative w-full max-w-5xl min-w-0">
				<div
					ref={stripRef}
					className="flex gap-4 overflow-x-auto no-scrollbar px-1 py-1"
					role="group"
					aria-label="Available providers"
				>
					{tiles.map((tile, index) => {
						const isDetected = isAgentAvailable(detectedAgents, tile.id);
						return (
							<AgentTileButton
								key={tile.id}
								tile={tile}
								index={index}
								theme={theme}
								isDetected={isDetected}
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
					})}
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
				width: '4rem',
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
