import { StallDiagnostics } from '../../shared/stallDiagnostics';
import { isWebDesktop } from './runtimeContext';

interface ScriptTiming {
	duration?: number;
	sourceURL?: string;
	sourceFunctionName?: string;
	sourceCharPosition?: number;
}

let disposeMonitor: (() => void) | undefined;

/** Script identity only for this app's own renderer assets; never log a full URL. */
function scriptLabel(script: ScriptTiming): string | undefined {
	if (!script.sourceURL) return;
	try {
		const source = new URL(script.sourceURL, window.location.href);
		const page = new URL(window.location.href);
		const root = page.pathname.slice(0, page.pathname.lastIndexOf('/') + 1);
		if (
			source.protocol !== page.protocol ||
			source.host !== page.host ||
			!source.pathname.startsWith(root)
		)
			return;
		const filename = source.pathname.slice(source.pathname.lastIndexOf('/') + 1);
		if (!/^[\w.~-]{1,120}\.(?:js|mjs|tsx?|jsx)$/.test(filename)) return;
		const name = script.sourceFunctionName;
		const functionName = name && /^[\w.$<>-]{1,80}$/.test(name) ? name : 'anonymous';
		const position = script.sourceCharPosition;
		return `${filename}:${functionName}${Number.isSafeInteger(position) && position! >= 0 ? `@${position}` : ''}`;
	} catch {
		return;
	}
}

/** Long-task detection plus optional Chromium script attribution, with bounded log volume. */
export function startRendererStallMonitoring(): () => void {
	if (disposeMonitor) return disposeMonitor;
	if (isWebDesktop() || typeof PerformanceObserver === 'undefined') return () => {};
	const diagnostics = new StallDiagnostics('renderer');
	diagnostics.start();
	let visibleSince = document.hidden ? Infinity : 0;
	const observers: PerformanceObserver[] = [];
	const supported = PerformanceObserver.supportedEntryTypes;
	if (supported.includes('longtask')) {
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (!document.hidden && entry.startTime >= visibleSince) {
					diagnostics.recordStall(entry.duration);
				}
			}
		});
		observer.observe({ type: 'longtask', buffered: true });
		observers.push(observer);
	}
	if (supported.includes('long-animation-frame')) {
		const observer = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				if (document.hidden || entry.startTime < visibleSince || entry.duration < 250) continue;
				const scripts = (entry as PerformanceEntry & { scripts?: ScriptTiming[] }).scripts;
				for (const script of scripts ?? []) {
					const label = scriptLabel(script);
					if (label) diagnostics.recordSynchronous('renderer-script', label, script.duration ?? 0);
				}
			}
		});
		observer.observe({ type: 'long-animation-frame', buffered: true });
		observers.push(observer);
	}
	const params = new URLSearchParams(window.location.search);
	const surface = params.has('quickChat')
		? 'quick-chat'
		: params.has('cadenzaHud')
			? 'hud'
			: params.has('floatingWidget')
				? 'floating-widget'
				: 'desktop';
	const flush = () => {
		if (document.hidden) return;
		const report = diagnostics.drain();
		if (report) {
			try {
				// Keep the IPC promise: RendererLogger intentionally returns void.
				void window.maestro?.logger
					?.log('warn', 'Background stall diagnostic', '[StallMonitor]', { ...report, surface })
					.catch(() => console.warn('[StallMonitor] Diagnostic log sink failed'));
			} catch {
				console.warn('[StallMonitor] Diagnostic log sink failed');
			}
		}
	};
	const timer = window.setInterval(flush, 5000);
	const visibilityChanged = () => {
		diagnostics.reset();
		visibleSince = document.hidden ? Infinity : performance.now();
	};
	document.addEventListener('visibilitychange', visibilityChanged);
	const dispose = () => {
		if (disposeMonitor !== dispose) return;
		for (const observer of observers) observer.disconnect();
		window.clearInterval(timer);
		document.removeEventListener('visibilitychange', visibilityChanged);
		window.removeEventListener('pagehide', dispose);
		flush();
		diagnostics.stop();
		disposeMonitor = undefined;
	};
	disposeMonitor = dispose;
	window.addEventListener('pagehide', dispose, { once: true });
	return dispose;
}
