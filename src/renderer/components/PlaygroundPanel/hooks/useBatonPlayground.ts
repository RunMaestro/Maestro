import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { safeClipboardWrite } from '../../../utils/clipboard';
import {
	BATON_DEFAULTS,
	buildBatonAnimationCss,
	buildBatonCopyCss,
	type EasingOption,
} from '../utils/batonCss';
import type { BatonPlaygroundState } from '../types';

export function useBatonPlayground(): BatonPlaygroundState {
	const [duration, setDuration] = useState(BATON_DEFAULTS.duration);
	const [peakAt, setPeakAt] = useState(BATON_DEFAULTS.peakAt);
	const [settleAt, setSettleAt] = useState(BATON_DEFAULTS.settleAt);
	const [translateAmount, setTranslateAmount] = useState(BATON_DEFAULTS.translateAmount);
	const [staggerOffset, setStaggerOffset] = useState(BATON_DEFAULTS.staggerOffset);
	const [easing, setEasing] = useState<EasingOption>(BATON_DEFAULTS.easing);
	const [batonActive, setBatonActive] = useState(true);
	const [batonCopySuccess, setBatonCopySuccess] = useState(false);
	const batonStyleRef = useRef<HTMLStyleElement | null>(null);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const settings = useMemo(
		() => ({
			duration,
			peakAt,
			settleAt,
			translateAmount,
			staggerOffset,
			easing,
		}),
		[duration, peakAt, settleAt, translateAmount, staggerOffset, easing]
	);

	const animationCss = useMemo(() => buildBatonAnimationCss(settings), [settings]);

	useEffect(() => {
		if (!batonStyleRef.current) {
			batonStyleRef.current = document.createElement('style');
			batonStyleRef.current.setAttribute('data-baton-playground', 'true');
			document.head.appendChild(batonStyleRef.current);
		}

		return () => {
			if (batonStyleRef.current) {
				batonStyleRef.current.parentNode?.removeChild(batonStyleRef.current);
				batonStyleRef.current = null;
			}
			if (copyTimerRef.current) {
				clearTimeout(copyTimerRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (batonStyleRef.current) {
			batonStyleRef.current.textContent = animationCss;
		}
	}, [animationCss]);

	const showCopySuccess = useCallback(() => {
		setBatonCopySuccess(true);
		if (copyTimerRef.current) {
			clearTimeout(copyTimerRef.current);
		}
		copyTimerRef.current = setTimeout(() => setBatonCopySuccess(false), 2000);
	}, []);

	const toggleBatonActive = useCallback(() => {
		setBatonActive((active) => !active);
	}, []);

	const resetBatonDefaults = useCallback(() => {
		setDuration(BATON_DEFAULTS.duration);
		setPeakAt(BATON_DEFAULTS.peakAt);
		setSettleAt(BATON_DEFAULTS.settleAt);
		setTranslateAmount(BATON_DEFAULTS.translateAmount);
		setStaggerOffset(BATON_DEFAULTS.staggerOffset);
		setEasing(BATON_DEFAULTS.easing);
		setBatonActive(true);
	}, []);

	const copyBatonSettings = useCallback(async () => {
		const ok = await safeClipboardWrite(buildBatonCopyCss(settings));
		if (ok) {
			showCopySuccess();
		}
	}, [settings, showCopySuccess]);

	return {
		...settings,
		batonActive,
		batonCopySuccess,
		setDuration,
		setPeakAt,
		setSettleAt,
		setTranslateAmount,
		setStaggerOffset,
		setEasing,
		toggleBatonActive,
		resetBatonDefaults,
		copyBatonSettings,
	};
}
