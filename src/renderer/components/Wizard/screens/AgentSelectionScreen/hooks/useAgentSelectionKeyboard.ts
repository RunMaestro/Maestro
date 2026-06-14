import { useCallback } from 'react';
import type { AgentSelectionKeyDown, AgentSelectionKeyboardArgs } from '../types';
import { AGENT_TILES } from '../utils/agentTiles';
import { getNextAgentTileIndex } from '../utils/agentGrid';
import { findDetectedAgent } from '../utils/agentAvailability';

export function useAgentSelectionKeyboard({
	isNameFieldFocused,
	focusedTileIndex,
	detectedAgents,
	nameInputRef,
	tileRefs,
	setIsNameFieldFocused,
	setFocusedTileIndex,
	setSelectedAgent,
	canProceedToNext,
	nextStep,
}: AgentSelectionKeyboardArgs): AgentSelectionKeyDown {
	return useCallback(
		(event) => {
			if (isNameFieldFocused) {
				if (event.key === 'Tab' && event.shiftKey) {
					event.preventDefault();
					setIsNameFieldFocused(false);
					for (let index = AGENT_TILES.length - 1; index >= 0; index -= 1) {
						const tile = AGENT_TILES[index];
						const detected = findDetectedAgent(detectedAgents, tile.id);
						if (tile.supported && detected?.available) {
							setFocusedTileIndex(index);
							tileRefs.current?.[index]?.focus();
							break;
						}
					}
				} else if (event.key === 'Enter' && canProceedToNext()) {
					event.preventDefault();
					nextStep();
				}
				return;
			}

			switch (event.key) {
				case 'ArrowUp':
				case 'ArrowDown':
				case 'ArrowLeft':
				case 'ArrowRight': {
					event.preventDefault();
					const nextIndex = getNextAgentTileIndex(focusedTileIndex, event.key);
					if (nextIndex !== focusedTileIndex) {
						setFocusedTileIndex(nextIndex);
						tileRefs.current?.[nextIndex]?.focus();
					}
					break;
				}

				case 'Tab':
					if (!event.shiftKey) {
						event.preventDefault();
						setIsNameFieldFocused(true);
						nameInputRef.current?.focus();
					}
					break;

				case 'Enter':
				case ' ': {
					event.preventDefault();
					const tile = AGENT_TILES[focusedTileIndex];
					const detected = findDetectedAgent(detectedAgents, tile.id);
					if (tile.supported && detected?.available) {
						setSelectedAgent(tile.id);
						if (event.key === 'Enter' && canProceedToNext()) {
							nextStep();
						}
					}
					break;
				}
			}
		},
		[
			isNameFieldFocused,
			focusedTileIndex,
			detectedAgents,
			nameInputRef,
			tileRefs,
			setIsNameFieldFocused,
			setFocusedTileIndex,
			setSelectedAgent,
			canProceedToNext,
			nextStep,
		]
	);
}
