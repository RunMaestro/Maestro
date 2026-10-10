/**
 * Owns tip rotation and persistence so the card can stay a pure renderer.
 * Mark tips seen on display, not on close: someone who reads three tips and
 * force-quits should not be shown the same three again on the next launch.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	buildTipOrder,
	getTipById,
	pickNextTip,
	type DidYouKnowTip,
} from '../../../shared/didYouKnow';
import { openBrowserTabAt } from '../../services/browserTabs';
import { selectActiveSession, updateSessionWith, useSessionStore } from '../../stores/sessionStore';
import { notifyToast } from '../../stores/notificationStore';
import { buildMaestroUrl } from '../../utils/buildMaestroUrl';
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
	const [isReading, setIsReading] = useState(false);
	const readingTab = useRef<{ sessionId: string; tabId: string } | null>(null);
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

	const navigateDocs = useCallback((nextTip: DidYouKnowTip) => {
		if (!nextTip.docsSlug) {
			notifyToast({
				color: 'theme',
				title: nextTip.title,
				message:
					'This tip has no documentation page. The browser stays on the last page you opened.',
				skipOsNotification: true,
				skipCustomNotification: true,
			});
			return;
		}
		const url = buildMaestroUrl(`https://docs.runmaestro.ai/${nextTip.docsSlug}`);
		const session = selectActiveSession(useSessionStore.getState());
		const target = readingTab.current;
		if (
			session &&
			target?.sessionId === session.id &&
			session.browserTabs?.some((t) => t.id === target.tabId)
		) {
			updateSessionWith(session.id, (s) => ({
				...s,
				browserTabs: s.browserTabs!.map((tab) =>
					tab.id === target.tabId ? { ...tab, url, title: nextTip.title, requestedUrl: url } : tab
				),
				activeBrowserTabId: target.tabId,
				activeFileTabId: null,
				activeTerminalTabId: null,
				activeGroupId: null,
				inputMode: 'ai',
			}));
		} else {
			openBrowserTabAt(url, { title: nextTip.title });
			const openedSession = selectActiveSession(useSessionStore.getState());
			readingTab.current = openedSession?.activeBrowserTabId
				? { sessionId: openedSession.id, tabId: openedSession.activeBrowserTabId }
				: null;
		}
	}, []);

	const openDocs = useCallback(() => {
		if (!tip) return;
		navigateDocs(tip);
		if (tip.docsSlug) setIsReading(true);
	}, [tip, navigateDocs]);
	const exitReading = useCallback(() => setIsReading(false), []);

	const goNext = useCallback(() => {
		if (cursor < history.length - 1) {
			setCursor(cursor + 1);
			const next = getTipById(history[cursor + 1], order);
			if (isReading && next) navigateDocs(next);
			return;
		}
		const next = pickNextTip(order, seenIds, currentId);
		if (next) {
			if (isReading) navigateDocs(next);
			setHistory([...history, next.id]);
			setCursor(history.length);
		}
	}, [cursor, history, order, seenIds, currentId, isReading, navigateDocs]);

	const goBack = useCallback(() => {
		if (cursor === 0) return;
		setCursor(cursor - 1);
		const previous = getTipById(history[cursor - 1], order);
		if (isReading && previous) navigateDocs(previous);
	}, [cursor, history, order, isReading, navigateDocs]);
	const dismissForever = useCallback(() => setEnabled(false), [setEnabled]);

	return {
		tip,
		index: tip ? order.indexOf(tip) + 1 : 0,
		total: order.length,
		canGoBack: cursor > 0,
		isReading,
		openDocs,
		exitReading,
		goNext,
		goBack,
		dismissForever,
		markSeen,
	};
}
