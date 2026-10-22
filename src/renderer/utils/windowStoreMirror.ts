/**
 * The one sync helper every floating widget uses to share a zustand store
 * across windows (`Plans/floating-widgets.md`, section 2).
 *
 * One window is a widget's authority: it owns the live state, publishes it with
 * `publishStoreState`, and answers commands with `onWidgetCommand`. Every other
 * window is a replica: it mirrors that state with `mirrorStoreState` and acts
 * through `sendWidgetCommand`. A replica never publishes, so state cannot echo
 * between windows.
 *
 * All four helpers are no-ops (and return a no-op unsubscribe) when
 * `floatingWidgetsAvailable()` is false, so a caller never branches twice.
 */

import type { StoreApi } from 'zustand';
import { shallow } from 'zustand/shallow';
import type { FloatingWidgetId } from '../../shared/floatingWidgets';
import { floatingWidgetsAvailable } from './floatingWidgetMode';

/** The fewest milliseconds between two publishes of one store. */
export const PUBLISH_INTERVAL_MS = 100;

const noop = () => {};

/**
 * Authority side: publish `select(state)` for `id` now, then again whenever the
 * selection changes (shallow-compared). Bursts coalesce to at most one publish
 * per `PUBLISH_INTERVAL_MS`, and the trailing publish carries the latest
 * selection. The returned unsubscribe also cancels a pending publish.
 */
export function publishStoreState<T, S>(
	id: FloatingWidgetId,
	store: Pick<StoreApi<T>, 'getState' | 'subscribe'>,
	select: (state: T) => S
): () => void {
	if (!floatingWidgetsAvailable()) return noop;
	const api = window.maestro.floatingWidgets;

	let latest = select(store.getState());
	let published = latest;
	let publishedAt = Date.now();
	let timer: ReturnType<typeof setTimeout> | null = null;
	api.publishState(id, latest);

	const flush = () => {
		timer = null;
		if (shallow(latest, published)) return;
		published = latest;
		publishedAt = Date.now();
		api.publishState(id, latest);
	};

	const unsubscribe = store.subscribe((state) => {
		const next = select(state);
		if (shallow(next, latest)) return;
		latest = next;
		if (timer) return;
		const wait = publishedAt + PUBLISH_INTERVAL_MS - Date.now();
		if (wait <= 0) flush();
		else timer = setTimeout(flush, wait);
	});

	return () => {
		unsubscribe();
		if (timer) clearTimeout(timer);
		timer = null;
	};
}

/**
 * Replica side: seed `store` from the latest state published for `id`, then
 * apply every snapshot the authority publishes through
 * `store.setState(apply(snapshot))`. It never publishes back. A seed that
 * arrives after a live snapshot is stale and is dropped.
 */
export function mirrorStoreState<T, S>(
	id: FloatingWidgetId,
	store: Pick<StoreApi<T>, 'setState'>,
	apply: (snapshot: S) => Partial<T>
): () => void {
	if (!floatingWidgetsAvailable()) return noop;
	const api = window.maestro.floatingWidgets;

	let disposed = false;
	let sawLiveState = false;
	// Subscribe before reading the seed so no publish falls between the two.
	const unsubscribe = api.onState<S>(id, (snapshot) => {
		sawLiveState = true;
		store.setState(apply(snapshot));
	});
	void api.getState<S>(id).then((snapshot) => {
		if (disposed || sawLiveState || snapshot === null) return;
		store.setState(apply(snapshot));
	});

	return () => {
		disposed = true;
		unsubscribe();
	};
}

/** Ask `id`'s authority to act. Main creates the authority's window when needed. */
export function sendWidgetCommand<C>(id: FloatingWidgetId, command: C): void {
	if (!floatingWidgetsAvailable()) return;
	window.maestro.floatingWidgets.sendCommand(id, command);
}

/** Authority side: call `handler` with each command sent to `id`. Returns the unsubscribe. */
export function onWidgetCommand<C>(
	id: FloatingWidgetId,
	handler: (command: C) => void
): () => void {
	if (!floatingWidgetsAvailable()) return noop;
	return window.maestro.floatingWidgets.onCommand<C>(id, handler);
}
