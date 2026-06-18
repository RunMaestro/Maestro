import { useCallback, useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { safeClipboardWrite } from '../../../utils/clipboard';
import {
	buildConfettiLaunchOptions,
	buildConfettiSettingsSnippet,
	DEFAULT_CONFETTI_COLORS,
	DEFAULT_CONFETTI_SETTINGS,
	DEFAULT_SELECTED_ORIGINS,
	toggleShapeSelection,
	type ConfettiShape,
} from '../utils/confettiSettings';
import type { ConfettiPlaygroundState } from '../types';

export function useConfettiPlayground(): ConfettiPlaygroundState {
	const [particleCount, setParticleCount] = useState(DEFAULT_CONFETTI_SETTINGS.particleCount);
	const [angle, setAngle] = useState(DEFAULT_CONFETTI_SETTINGS.angle);
	const [spread, setSpread] = useState(DEFAULT_CONFETTI_SETTINGS.spread);
	const [startVelocity, setStartVelocity] = useState(DEFAULT_CONFETTI_SETTINGS.startVelocity);
	const [gravity, setGravity] = useState(DEFAULT_CONFETTI_SETTINGS.gravity);
	const [decay, setDecay] = useState(DEFAULT_CONFETTI_SETTINGS.decay);
	const [drift, setDrift] = useState(DEFAULT_CONFETTI_SETTINGS.drift);
	const [scalar, setScalar] = useState(DEFAULT_CONFETTI_SETTINGS.scalar);
	const [ticks, setTicks] = useState(DEFAULT_CONFETTI_SETTINGS.ticks);
	const [flat, setFlat] = useState(DEFAULT_CONFETTI_SETTINGS.flat);
	const [shapes, setShapes] = useState<ConfettiShape[]>(DEFAULT_CONFETTI_SETTINGS.shapes);
	const [colors, setColors] = useState<string[]>(DEFAULT_CONFETTI_COLORS);
	const [selectedOrigins, setSelectedOrigins] = useState<Set<string>>(
		new Set(DEFAULT_SELECTED_ORIGINS)
	);
	const [copySuccess, setCopySuccess] = useState(false);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (copyTimerRef.current) {
				clearTimeout(copyTimerRef.current);
			}
		};
	}, []);

	const settings = {
		particleCount,
		angle,
		spread,
		startVelocity,
		gravity,
		decay,
		drift,
		scalar,
		ticks,
		flat,
		shapes,
		colors,
	};

	const showCopySuccess = useCallback(() => {
		setCopySuccess(true);
		if (copyTimerRef.current) {
			clearTimeout(copyTimerRef.current);
		}
		copyTimerRef.current = setTimeout(() => setCopySuccess(false), 2000);
	}, []);

	const toggleOrigin = useCallback((row: number, col: number) => {
		const key = `${row}-${col}`;
		setSelectedOrigins((previousOrigins) => {
			const nextOrigins = new Set(previousOrigins);
			if (nextOrigins.has(key)) {
				nextOrigins.delete(key);
			} else {
				nextOrigins.add(key);
			}
			return nextOrigins;
		});
	}, []);

	const toggleShape = useCallback((shape: ConfettiShape) => {
		setShapes((previousShapes) => toggleShapeSelection(previousShapes, shape));
	}, []);

	const setColorAt = useCallback((index: number, color: string) => {
		setColors((previousColors) => {
			const nextColors = [...previousColors];
			nextColors[index] = color;
			return nextColors;
		});
	}, []);

	const addColor = useCallback(() => {
		setColors((previousColors) =>
			previousColors.length < 12 ? [...previousColors, '#FFFFFF'] : previousColors
		);
	}, []);

	const removeColor = useCallback((index: number) => {
		setColors((previousColors) =>
			previousColors.length > 1
				? previousColors.filter((_, currentIndex) => currentIndex !== index)
				: previousColors
		);
	}, []);

	const firePlaygroundConfetti = useCallback(() => {
		const launchOptions = buildConfettiLaunchOptions(settings, selectedOrigins);
		launchOptions.forEach((options) => {
			confetti(options);
		});
	}, [settings, selectedOrigins]);

	const resetConfettiSettings = useCallback(() => {
		setParticleCount(DEFAULT_CONFETTI_SETTINGS.particleCount);
		setAngle(DEFAULT_CONFETTI_SETTINGS.angle);
		setSpread(DEFAULT_CONFETTI_SETTINGS.spread);
		setStartVelocity(DEFAULT_CONFETTI_SETTINGS.startVelocity);
		setGravity(DEFAULT_CONFETTI_SETTINGS.gravity);
		setDecay(DEFAULT_CONFETTI_SETTINGS.decay);
		setDrift(DEFAULT_CONFETTI_SETTINGS.drift);
		setScalar(DEFAULT_CONFETTI_SETTINGS.scalar);
		setTicks(DEFAULT_CONFETTI_SETTINGS.ticks);
		setFlat(DEFAULT_CONFETTI_SETTINGS.flat);
		setShapes(DEFAULT_CONFETTI_SETTINGS.shapes);
		setColors(DEFAULT_CONFETTI_COLORS);
		setSelectedOrigins(new Set(DEFAULT_SELECTED_ORIGINS));
	}, []);

	const copyConfettiSettings = useCallback(async () => {
		const ok = await safeClipboardWrite(buildConfettiSettingsSnippet(settings, selectedOrigins));
		if (ok) {
			showCopySuccess();
		}
	}, [settings, selectedOrigins, showCopySuccess]);

	return {
		...settings,
		setParticleCount,
		setAngle,
		setSpread,
		setStartVelocity,
		setGravity,
		setDecay,
		setDrift,
		setScalar,
		setTicks,
		setFlat,
		selectedOrigins,
		copySuccess,
		toggleOrigin,
		toggleShape,
		setColorAt,
		addColor,
		removeColor,
		firePlaygroundConfetti,
		resetConfettiSettings,
		copyConfettiSettings,
	};
}
