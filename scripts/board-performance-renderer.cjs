// Inject with Playwright page.evaluate(installRendererMeasurement). This records
// renderer observations only; the caller must establish isolation before launch.
function installRendererMeasurement() {
	if (window.__boardMeasurement) throw new Error('Renderer measurement already installed');
	let current = null;
	let generation = 0;
	const observer = new PerformanceObserver((list) => {
		if (current) {
			for (const entry of list.getEntries()) {
				current.longtasks.push({ start: entry.startTime, ms: entry.duration });
			}
		}
	});
	observer.observe({ type: 'longtask', buffered: false });
	const mutations = new MutationObserver(() => {
		if (current) current.mutationBatches++;
	});
	mutations.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		characterData: true,
	});
	const onInput = (event) => {
		if (!current || !event.isTrusted) return;
		const started = performance.now();
		const sampleGeneration = generation;
		requestAnimationFrame(() => {
			if (current && generation === sampleGeneration) {
				current.inputs.push(performance.now() - started);
			}
		});
	};
	for (const type of ['click', 'keydown', 'input']) document.addEventListener(type, onInput, true);
	window.__boardMeasurement = {
		begin() {
			if (current) throw new Error('Measurement already active');
			observer.takeRecords();
			mutations.takeRecords();
			generation++;
			current = { startedAt: performance.now(), inputs: [], longtasks: [], mutationBatches: 0 };
		},
		end() {
			if (!current) throw new Error('No active measurement');
			for (const entry of observer.takeRecords()) {
				current.longtasks.push({ start: entry.startTime, ms: entry.duration });
			}
			if (mutations.takeRecords().length) current.mutationBatches++;
			const result = { ...current, endedAt: performance.now() };
			current = null;
			generation++;
			return result;
		},
		dispose() {
			observer.disconnect();
			mutations.disconnect();
			for (const type of ['click', 'keydown', 'input'])
				document.removeEventListener(type, onInput, true);
			current = null;
			generation++;
			delete window.__boardMeasurement;
		},
	};
}

module.exports = { installRendererMeasurement };
