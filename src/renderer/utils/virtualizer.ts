import { observeElementOffset } from '@tanstack/react-virtual';

/** The installed TanStack observer removes listeners on cleanup, but its trailing
 * scroll debounce still fires. Keep that delayed callback inside the subscription
 * lifetime so it cannot notify React after the list (or jsdom) has unmounted.
 * Delegate measurement, RTL and scrollend semantics to the canonical observer.
 */
export const observeElementOffsetWhileMounted: typeof observeElementOffset = (
	instance,
	callback
) => {
	let subscribed = true;
	const unsubscribe = observeElementOffset(instance, (offset, scrolling) => {
		if (subscribed) callback(offset, scrolling);
	});
	return () => {
		subscribed = false;
		unsubscribe?.();
	};
};
