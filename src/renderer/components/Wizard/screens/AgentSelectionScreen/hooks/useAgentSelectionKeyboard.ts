import { useCallback } from 'react';
import type { AgentSelectionKeyDown, AgentSelectionKeyboardArgs } from '../types';
import { PROVIDER_BAR_NAV_EXEMPT_ATTR } from '../../../../ui/ProviderAvailabilityBar';
import { getNextAgentTileIndex } from '../utils/agentGrid';
import { findDetectedAgent } from '../utils/agentAvailability';

export function useAgentSelectionKeyboard({
	tiles,
	tileColumns,
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
			if ((event.target as HTMLElement | null)?.closest?.(`[${PROVIDER_BAR_NAV_EXEMPT_ATTR}]`)) {
				return;
			}

			if (isNameFieldFocused) {
				if (event.key === 'Tab' && event.shiftKey) {
					event.preventDefault();
					setIsNameFieldFocused(false);
					for (let index = tiles.length - 1; index >= 0; index -= 1) {
						const tile = tiles[index];
						const detected = findDetectedAgent(detectedAgents, tile.id);
						if (tile.supported && detected?.available) {
							setFocusedTileIndex(index);
							// `preventScroll`: the strip scrolls the focused tile into view
							// itself, clear of the edge fades. The browser's own scroll would
							// beat it to the punch and park the tile flush against one.
							tileRefs.current?.[index]?.focus({ preventScroll: true });
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
					const nextIndex = getNextAgentTileIndex(
						focusedTileIndex,
						event.key,
						tiles.length,
						tileColumns
					);
					if (nextIndex !== focusedTileIndex) {
						setFocusedTileIndex(nextIndex);
						// A disabled tile cannot take DOM focus, so this is a no-op on one.
						// The strip scrolls off `focusedTileIndex` rather than off focus for
						// exactly that reason - arrowing across a dimmed provider still moves
						// the strip with the ring.
						tileRefs.current?.[nextIndex]?.focus({ preventScroll: true });
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
					const tile = tiles[focusedTileIndex];
					if (!tile) break;
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
			tiles,
			tileColumns,
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
