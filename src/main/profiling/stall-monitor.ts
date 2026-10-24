import { app, ipcMain, powerMonitor } from 'electron';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mainStallDiagnostics, emitMainStallReport } from '../../shared/stallDiagnostics';

let disposeMonitor: (() => void) | undefined;

/** Full-desktop bootstrap only: no stores, network, inspector, or continuous CPU profiler. */
export function startStallMonitoring(): () => void {
	if (disposeMonitor) return disposeMonitor;
	const diagnostics = mainStallDiagnostics;
	diagnostics.start();
	const histogram = monitorEventLoopDelay({ resolution: 50 });
	histogram.enable();
	let suspended = false;
	let nextReportAt = performance.now() + 5000;

	const originalHandle = ipcMain.handle;
	const instrumentedHandle: typeof ipcMain.handle = function (
		this: typeof ipcMain,
		channel,
		listener
	) {
		return originalHandle.call(this, channel, async (event, ...args) => {
			const operation = diagnostics.beginOperation(channel);
			try {
				return await diagnostics.measureSynchronous('ipc', channel, () => listener(event, ...args));
			} finally {
				diagnostics.endOperation(operation);
			}
		});
	};
	ipcMain.handle = instrumentedHandle;

	const timer = setInterval(() => {
		if (suspended) return;
		diagnostics.recordStall(histogram.max / 1e6);
		histogram.reset();
		const now = performance.now();
		if (now >= nextReportAt) {
			nextReportAt = now + 5000;
			const report = diagnostics.drain();
			if (report) emitMainStallReport(report);
		}
	}, 1000);
	timer.unref();

	const suspend = () => {
		suspended = true;
		histogram.disable();
		diagnostics.reset();
	};
	const resume = () => {
		diagnostics.reset();
		histogram.reset();
		histogram.enable();
		suspended = false;
		nextReportAt = performance.now() + 5000;
	};
	const attachPowerEvents = () => {
		if (disposeMonitor !== dispose) return;
		powerMonitor.on('suspend', suspend);
		powerMonitor.on('resume', resume);
	};
	const dispose = () => {
		if (disposeMonitor !== dispose) return;
		clearInterval(timer);
		histogram.disable();
		if (!suspended) {
			diagnostics.recordStall(histogram.max / 1e6);
			const report = diagnostics.drain();
			if (report) emitMainStallReport(report);
		}
		diagnostics.stop();
		if (ipcMain.handle === instrumentedHandle) ipcMain.handle = originalHandle;
		powerMonitor.removeListener('suspend', suspend);
		powerMonitor.removeListener('resume', resume);
		app.removeListener('will-quit', dispose);
		disposeMonitor = undefined;
	};
	disposeMonitor = dispose;
	app.once('will-quit', dispose);
	void app.whenReady().then(attachPowerEvents);
	return dispose;
}
