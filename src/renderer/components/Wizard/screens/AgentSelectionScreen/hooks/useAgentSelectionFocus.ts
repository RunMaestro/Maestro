import { useEffect } from 'react';
import type { AgentConfig } from '../../../../../types';
import type { AgentSelectionRefs } from '../types';
import { AGENT_TILES } from '../utils/agentTiles';
import {
	countSelectableAgentTiles,
	findFirstSelectableTileIndex,
} from '../utils/agentAvailability';

interface UseAgentSelectionFocusArgs {
	isDetecting: boolean;
	selectedAgent: string | null;
	detectedAgents: AgentConfig[];
	refs: AgentSelectionRefs;
	setFocusedTileIndex: (index: number) => void;
	setIsNameFieldFocused: (focused: boolean) => void;
}

export function useAgentSelectionFocus({
	isDetecting,
	selectedAgent,
	detectedAgents,
	refs,
	setFocusedTileIndex,
	setIsNameFieldFocused,
}: UseAgentSelectionFocusArgs): void {
	useEffect(() => {
		if (isDetecting) return;

		const supportedAndDetectedCount = countSelectableAgentTiles(AGENT_TILES, detectedAgents);

		if (supportedAndDetectedCount <= 1) {
			setIsNameFieldFocused(true);
			refs.nameInputRef.current?.focus();
			return;
		}

		let focusIndex = 0;
		if (selectedAgent) {
			const selectedIndex = AGENT_TILES.findIndex((tile) => tile.id === selectedAgent);
			if (selectedIndex !== -1) {
				focusIndex = selectedIndex;
				setFocusedTileIndex(selectedIndex);
			}
		} else {
			const firstAvailableIndex = findFirstSelectableTileIndex(AGENT_TILES, detectedAgents);
			if (firstAvailableIndex !== -1) {
				focusIndex = firstAvailableIndex;
				setFocusedTileIndex(firstAvailableIndex);
			}
		}

		refs.tileRefs.current?.[focusIndex]?.focus();
	}, [
		isDetecting,
		selectedAgent,
		detectedAgents,
		refs.nameInputRef,
		refs.tileRefs,
		setFocusedTileIndex,
		setIsNameFieldFocused,
	]);
}
