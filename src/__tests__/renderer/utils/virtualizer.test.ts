import { afterEach, expect, it, vi } from 'vitest';
import { Virtualizer } from '@tanstack/react-virtual';

import { observeElementOffsetWhileMounted as observeElementOffset } from '../../../renderer/utils/virtualizer';

afterEach(() => vi.useRealTimers());

it('does not notify a disposed scroll observer after its debounce expires', () => {
	vi.useFakeTimers();
	const element = document.createElement('div');
	const notify = vi.fn();
	const instance = new Virtualizer<HTMLDivElement, Element>({
		count: 1,
		getScrollElement: () => element,
		estimateSize: () => 100,
		observeElementRect: () => () => {},
		observeElementOffset,
		scrollToFn: () => {},
	});
	instance.scrollElement = element;
	instance.targetWindow = window;
	const dispose = observeElementOffset(instance, notify)!;
	element.scrollTop = 300;
	element.dispatchEvent(new Event('scroll'));
	expect(notify).toHaveBeenLastCalledWith(300, true);
	vi.runOnlyPendingTimers();
	expect(notify).toHaveBeenLastCalledWith(300, false);
	element.scrollTop = 400;
	element.dispatchEvent(new Event('scroll'));
	expect(notify).toHaveBeenLastCalledWith(400, true);
	dispose();
	notify.mockClear();
	element.dispatchEvent(new Event('scroll'));
	vi.runOnlyPendingTimers();
	expect(notify).not.toHaveBeenCalled();
});
