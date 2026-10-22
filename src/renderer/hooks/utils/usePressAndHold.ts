/**
 * usePressAndHold - one button that is both a tap and a walkie-talkie key.
 *
 * A microphone button has to answer two different habits, and a voice UI that
 * picks one has half its users fighting it: someone dictating a paragraph holds
 * the button down, and someone having a conversation taps it once and forgets
 * about it. Both surfaces that offer that button - the voice HUD's talk control
 * and the document chat's push button - classify the press against the SAME
 * `holdThresholdMs` the global hotkey uses (`resolveHoldThresholdMs`), so a
 * button and a key can never decide "hold" at different moments.
 *
 * Three properties are the reason this is a hook rather than two copies of the
 * timer, because each one is a bug the copies got wrong before:
 *
 *   - **Release is window-scoped.** An element-scoped `onPointerUp` never fires
 *     when the user drags off the button, which is the commonest way to abort a
 *     press, and the floor is then left open with nothing holding it.
 *   - **Unmount releases.** A press interrupted by the surface closing must
 *     still end the hold; the alternative is a hot microphone with no widget
 *     attached to it.
 *   - **The state lives in refs.** The window listener is attached once and
 *     would otherwise read a `holding` from the render it was created in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UsePressAndHoldOptions {
	/**
	 * How long a press has to last before it counts as a hold. Feed it
	 * `resolveHoldThresholdMs(settings.voiceHoldThresholdMs)` so every surface
	 * classifies against the user's own number.
	 */
	holdThresholdMs: number;
	/** The press crossed the threshold: the walkie-talkie key is down. */
	onHoldStart: () => void;
	/** The hold ended - released, cancelled, or the surface unmounted. */
	onHoldEnd: () => void;
	/** The press was released before the threshold. */
	onTap: () => void;
	/** When true, presses are ignored entirely. */
	disabled?: boolean;
}

export interface UsePressAndHoldReturn {
	/** True while the walkie-talkie key is down. Drive the button's label from it. */
	holding: boolean;
	/** Start classifying a press. Call from `onPointerDown`. */
	beginPress: () => void;
	/** Finish a press, as a hold-release or a tap. Call from `onPointerUp`. */
	endPress: () => void;
}

export function usePressAndHold({
	holdThresholdMs,
	onHoldStart,
	onHoldEnd,
	onTap,
	disabled = false,
}: UsePressAndHoldOptions): UsePressAndHoldReturn {
	const [holding, setHolding] = useState(false);
	const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const holdingRef = useRef(false);
	const pressedRef = useRef(false);

	// The callbacks are read through a ref so the window listener and the unmount
	// cleanup below can be attached once. Re-attaching them on every render of a
	// caller that passes inline arrows would tear down and rebuild the listener
	// mid-press, and the unmount cleanup would fire on every render instead of on
	// the one that matters.
	const callbacks = useRef({ onHoldStart, onHoldEnd, onTap });
	callbacks.current = { onHoldStart, onHoldEnd, onTap };

	const clearHoldTimer = useCallback(() => {
		if (holdTimer.current === null) return;
		clearTimeout(holdTimer.current);
		holdTimer.current = null;
	}, []);

	useEffect(() => {
		return () => {
			clearHoldTimer();
			if (holdingRef.current) {
				holdingRef.current = false;
				callbacks.current.onHoldEnd();
			}
		};
	}, [clearHoldTimer]);

	const beginPress = useCallback(() => {
		if (disabled || pressedRef.current) return;
		pressedRef.current = true;
		clearHoldTimer();
		holdTimer.current = setTimeout(() => {
			holdTimer.current = null;
			holdingRef.current = true;
			setHolding(true);
			callbacks.current.onHoldStart();
		}, holdThresholdMs);
	}, [clearHoldTimer, disabled, holdThresholdMs]);

	const endPress = useCallback(() => {
		if (!pressedRef.current) return;
		pressedRef.current = false;
		clearHoldTimer();
		if (holdingRef.current) {
			holdingRef.current = false;
			setHolding(false);
			callbacks.current.onHoldEnd();
			return;
		}
		callbacks.current.onTap();
	}, [clearHoldTimer]);

	// Window-scoped release, so a press that ends with the pointer somewhere else
	// still counts. Armed while a press is in flight, which is either the timer
	// still running or the hold already started.
	useEffect(() => {
		if (!holding && holdTimer.current === null) return;
		const onUp = () => endPress();
		window.addEventListener('pointerup', onUp);
		window.addEventListener('pointercancel', onUp);
		return () => {
			window.removeEventListener('pointerup', onUp);
			window.removeEventListener('pointercancel', onUp);
		};
	}, [endPress, holding]);

	return { holding, beginPress, endPress };
}

export default usePressAndHold;
