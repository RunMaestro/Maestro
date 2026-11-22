/**
 * useDictationPress - one press, classified as a tap or a hold, driving a
 * dictation.
 *
 * Both ways into dictation use it: the `<DictationButton>` beside a text box
 * (the press is a pointer) and the `dictate` shortcut (the press is a chord).
 * A tap toggles the recording; a hold records while held. The classification
 * is `usePressAndHold` against the same `holdThresholdMs` the voice hotkey and
 * the voice HUD's talk button use, so no surface decides "hold" at a different
 * moment than another.
 *
 * `getTarget` is asked when the press resolves, not when it begins, so the
 * shortcut reads the element that holds the caret at that moment.
 */

import { useRef } from 'react';

import { startDictation, stopDictation, toggleDictation } from '../../services/dictation';
import { useDictationStore } from '../../stores/dictationStore';
import { useVoiceUiStore } from '../../stores/voiceUiStore';
import type { DictationTarget } from '../../utils/dictationTargets';
import { usePressAndHold, type UsePressAndHoldReturn } from '../utils/usePressAndHold';

export function useDictationPress(
	getTarget: () => DictationTarget | null,
	disabled = false
): UsePressAndHoldReturn {
	const holdThresholdMs = useVoiceUiStore((s) => s.holdThresholdMs);
	const getTargetRef = useRef(getTarget);
	getTargetRef.current = getTarget;

	return usePressAndHold({
		holdThresholdMs,
		disabled,
		onHoldStart: () => {
			// Holding while a dictation is already recording is a "keep it open"
			// gesture: restarting would throw away what was said so far. The
			// release below still stops it.
			if (useDictationStore.getState().phase !== 'idle') return;
			const target = getTargetRef.current();
			if (target) void startDictation(target);
			else toggleDictation(null);
		},
		onHoldEnd: () => void stopDictation(),
		onTap: () => toggleDictation(getTargetRef.current()),
	});
}
