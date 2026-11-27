/**
 * `useElementSize` - an element's width and height for layout that has to be
 * computed in JS. A browser tab shown at a viewport preset sizes its page from
 * the space the tab gives it, so the numbers have to be right on the first
 * paint and cost nothing while no preset is on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { useElementSize, type ElementSize } from '../../../../renderer/hooks/ui/useElementWidth';

class FakeResizeObserver {
	static all: FakeResizeObserver[] = [];
	observed: Element[] = [];
	disconnected = false;
	constructor(private readonly callback: ResizeObserverCallback) {
		FakeResizeObserver.all.push(this);
	}
	observe(target: Element) {
		this.observed.push(target);
	}
	disconnect() {
		this.disconnected = true;
	}
	/** Report a resize, as the browser does after layout. */
	fire() {
		this.callback([], this as unknown as ResizeObserver);
	}
}

const size = { width: 400, height: 300 };
const seen: ElementSize[] = [];

function Probe({ enabled }: { enabled?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	seen.push(useElementSize(ref, enabled));
	return <div ref={ref} data-testid="probe" />;
}

const latest = () => seen[seen.length - 1];

describe('useElementSize', () => {
	beforeEach(() => {
		seen.length = 0;
		size.width = 400;
		size.height = 300;
		FakeResizeObserver.all = [];
		vi.stubGlobal('ResizeObserver', FakeResizeObserver);
		vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => size.width);
		vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => size.height);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('has the real size in the first committed result, not a frame of zeros', () => {
		render(<Probe />);

		expect(latest()).toEqual({ width: 400, height: 300 });
	});

	it('follows a resize the observer reports', () => {
		render(<Probe />);

		size.width = 640;
		size.height = 360;
		act(() => FakeResizeObserver.all[0].fire());

		expect(latest()).toEqual({ width: 640, height: 360 });
	});

	it('keeps the same object when a report changes nothing, so a consumer can memoize on it', () => {
		render(<Probe />);
		const before = latest();
		const renders = seen.length;

		act(() => FakeResizeObserver.all[0].fire());

		expect(latest()).toBe(before);
		expect(seen.length).toBe(renders);
	});

	it('watches only the element it was given', () => {
		const { getByTestId } = render(<Probe />);

		expect(FakeResizeObserver.all).toHaveLength(1);
		expect(FakeResizeObserver.all[0].observed).toEqual([getByTestId('probe')]);
	});

	it('does not observe or measure while it is not enabled', () => {
		render(<Probe enabled={false} />);

		expect(latest()).toEqual({ width: 0, height: 0 });
		expect(FakeResizeObserver.all).toHaveLength(0);
	});

	it('measures at once when it becomes enabled, and lets go of the observer when it stops', () => {
		const { rerender } = render(<Probe enabled={false} />);

		rerender(<Probe enabled />);
		expect(latest()).toEqual({ width: 400, height: 300 });
		expect(FakeResizeObserver.all).toHaveLength(1);

		rerender(<Probe enabled={false} />);
		expect(FakeResizeObserver.all[0].disconnected).toBe(true);
	});

	it('lets go of the observer on unmount', () => {
		const { unmount } = render(<Probe />);

		unmount();

		expect(FakeResizeObserver.all[0].disconnected).toBe(true);
	});

	it('still measures once where there is no ResizeObserver (jsdom)', () => {
		vi.stubGlobal('ResizeObserver', undefined);

		render(<Probe />);

		expect(latest()).toEqual({ width: 400, height: 300 });
	});
});
