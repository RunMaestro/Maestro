export class FakeIntersectionObserver implements IntersectionObserver {
	static instances: FakeIntersectionObserver[] = [];
	callback: IntersectionObserverCallback;
	observed: Element[] = [];
	disconnected = false;
	root = null;
	rootMargin = '';
	scrollMargin = '';
	thresholds = [];

	constructor(cb: IntersectionObserverCallback) {
		this.callback = cb;
		FakeIntersectionObserver.instances.push(this);
	}

	observe(el: Element) {
		this.observed.push(el);
	}

	unobserve(el: Element) {
		this.observed = this.observed.filter((o) => o !== el);
	}

	disconnect() {
		this.disconnected = true;
	}

	takeRecords() {
		return [];
	}

	trigger(targets: Element[]) {
		const entries = targets.map(
			(target) =>
				({
					target,
					isIntersecting: true,
					intersectionRatio: 1,
					boundingClientRect: target.getBoundingClientRect(),
					intersectionRect: target.getBoundingClientRect(),
					rootBounds: null,
					time: 0,
				}) as IntersectionObserverEntry
		);
		this.callback(entries, this);
	}
}
