import { useEffect, useRef } from 'react';
import type { AgentConfig } from '../../../../../types';
import type { AgentSelectionRefs, AgentTile } from '../types';
import {
	countSelectableAgentTiles,
	findFirstSelectableTileIndex,
} from '../utils/agentAvailability';

interface UseAgentSelectionFocusArgs {
	/** The tiles the strip renders right now - what the focus index refers to. */
	tiles: AgentTile[];
	isDetecting: boolean;
	selectedAgent: string | null;
	detectedAgents: AgentConfig[];
	refs: AgentSelectionRefs;
	setFocusedTileIndex: (index: number) => void;
	setIsNameFieldFocused: (focused: boolean) => void;
}

export function useAgentSelectionFocus({
	tiles,
	isDetecting,
	selectedAgent,
	detectedAgents,
	refs,
	setFocusedTileIndex,
	setIsNameFieldFocused,
}: UseAgentSelectionFocusArgs): void {
	// Read through a ref, and deliberately keep `tiles` out of the dependency
	// list below. This effect MOVES FOCUS, and the tile list changes when the
	// user flips "Show unavailable" - depending on it would rip focus out of the
	// toggle they just clicked and drop it on a tile, mid-interaction.
	const tilesRef = useRef(tiles);
	tilesRef.current = tiles;

	useEffect(() => {
		if (isDetecting) return;

		const currentTiles = tilesRef.current;
		const supportedAndDetectedCount = countSelectableAgentTiles(currentTiles, detectedAgents);

		if (supportedAndDetectedCount <= 1) {
			setIsNameFieldFocused(true);
			refs.nameInputRef.current?.focus();
			return;
		}

		let focusIndex = 0;
		if (selectedAgent) {
			const selectedIndex = currentTiles.findIndex((tile) => tile.id === selectedAgent);
			if (selectedIndex !== -1) {
				focusIndex = selectedIndex;
				setFocusedTileIndex(selectedIndex);
			}
		} else {
			const firstAvailableIndex = findFirstSelectableTileIndex(currentTiles, detectedAgents);
			if (firstAvailableIndex !== -1) {
				focusIndex = firstAvailableIndex;
				setFocusedTileIndex(firstAvailableIndex);
			}
		}

		// `preventScroll`: the strip brings the focused tile into view itself, clear
		// of the edge fades that float over its ends.
		refs.tileRefs.current?.[focusIndex]?.focus({ preventScroll: true });
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
