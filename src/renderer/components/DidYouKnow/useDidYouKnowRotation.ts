/**
 * Owns tip rotation and persistence so the card can stay a pure renderer.
 * Mark tips seen on display, not on close: someone who reads three tips and
 * force-quits should not be shown the same three again on the next launch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildTipOrder, getTipById, pickNextTip } from '../../../shared/didYouKnow';
import { useSettingsStore } from '../../stores/settingsStore';

export function useDidYouKnowRotation({ startTipId }: { startTipId?: string }) {
	const seenIds = useSettingsStore((s) => s.didYouKnowSeenTipIds);
	const storedSeed = useSettingsStore((s) => s.didYouKnowSeed);
	const setSeed = useSettingsStore((s) => s.setDidYouKnowSeed);
	const setSeenIds = useSettingsStore((s) => s.setDidYouKnowSeenTipIds);
	const setEnabled = useSettingsStore((s) => s.setDidYouKnowEnabled);
	const [initialSeed] = useState(() => storedSeed || Math.floor(Math.random() * 2 ** 32));
	const seedPersisted = useRef(false);
	const seed = storedSeed || initialSeed;
	const order = useMemo(() => buildTipOrder(seed), [seed]);
	const [history, setHistory] = useState<string[]>(() => {
		const first = (startTipId && getTipById(startTipId, order)) || pickNextTip(order, seenIds);
		return first ? [first.id] : [];
	});
	const [cursor, setCursor] = useState(0);
	const currentId = history[cursor];
	const tip = getTipById(currentId, order) ?? null;

	useEffect(() => {
		// Persist after commit, including when the generated uint32 happens to be zero.
		if (storedSeed === 0 && !seedPersisted.current) {
			seedPersisted.current = true;
			setSeed(initialSeed);
		}
	}, [storedSeed, initialSeed, setSeed]);

	const markSeen = useCallback(
		(id: string) => {
			// Read the latest value so consecutive calls cannot overwrite each other,
			// and Strict Mode's effect replay does not write the same tip twice.
			const latestSeenIds = useSettingsStore.getState().didYouKnowSeenTipIds;
			if (!latestSeenIds.includes(id)) setSeenIds([...latestSeenIds, id]);
		},
		[setSeenIds]
	);

	useEffect(() => {
		if (currentId) markSeen(currentId);
	}, [currentId, markSeen]);

	const goNext = useCallback(() => {
		if (cursor < history.length - 1) {
			setCursor(cursor + 1);
			return;
		}
		const next = pickNextTip(order, seenIds, currentId);
		if (next) {
			setHistory([...history, next.id]);
			setCursor(history.length);
		}
	}, [cursor, history, order, seenIds, currentId]);

	const goBack = useCallback(() => setCursor((value) => Math.max(0, value - 1)), []);
	const dismissForever = useCallback(() => setEnabled(false), [setEnabled]);

	return {
		tip,
		index: tip ? order.indexOf(tip) + 1 : 0,
		total: order.length,
		canGoBack: cursor > 0,
		goNext,
		goBack,
		dismissForever,
		markSeen,
	};
}
