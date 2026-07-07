import type { RefObject } from 'react';
import type { AgentConfig, Theme } from '../../../../../types';
import type { AgentTile } from '../types';
import { getAgentTileColSpanClass } from '../utils/agentGrid';
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
	return (
		<div className="flex flex-col items-center gap-4">
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				Select the provider that will power your agent.
			</p>
			<div className="grid grid-cols-8 gap-4 max-w-5xl">
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
							colSpanClass={getAgentTileColSpanClass(index)}
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
		</div>
	);
}
