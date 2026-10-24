import { describe, expect, it, vi } from 'vitest';
import { startRendererStallMonitoring } from '../../../renderer/utils/stallMonitor';

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock('../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: () => runtime.web,
}));

describe('renderer stall diagnostics', () => {
	it('does not install observers or emit host diagnostics from web-desktop or attached Lite', async () => {
		vi.useFakeTimers();
		runtime.web = true;
		const observer = vi.fn();
		Object.assign(observer, { supportedEntryTypes: ['longtask', 'long-animation-frame'] });
		vi.stubGlobal('PerformanceObserver', observer);
		const log = vi.spyOn(window.maestro.logger, 'log');
		let stop: (() => void) | undefined;
		try {
			stop = startRendererStallMonitoring();
			await vi.advanceTimersByTimeAsync(10000);
			expect(observer).not.toHaveBeenCalled();
			expect(log).not.toHaveBeenCalled();
		} finally {
			stop?.();
			runtime.web = false;
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});

	it('logs app script identity without URL secrets, external scripts, or filesystem paths', async () => {
		vi.useFakeTimers();
		const callbacks = new Map<string, (list: { getEntries(): unknown[] }) => void>();
		class Observer {
			static supportedEntryTypes = ['longtask', 'long-animation-frame'];
			constructor(private readonly callback: (list: { getEntries(): unknown[] }) => void) {}
			observe({ type }: { type: string }): void {
				callbacks.set(type, this.callback);
			}
			disconnect(): void {}
		}
		vi.stubGlobal('PerformanceObserver', Observer);
		vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
		const log = vi.spyOn(window.maestro.logger, 'log').mockResolvedValue(undefined);
		let stop: (() => void) | undefined;
		try {
			stop = startRendererStallMonitoring();
			const ownScript = new URL('assets/view.js?token=PRIVATE_QUERY_SECRET', window.location.href)
				.href;
			callbacks.get('long-animation-frame')!({
				getEntries: () => [
					{
						startTime: performance.now(),
						duration: 650,
						scripts: [
							{
								sourceURL: ownScript,
								sourceFunctionName: 'slowRender',
								sourceCharPosition: 123,
								duration: 650,
							},
							{ sourceURL: 'https://external.invalid/PRIVATE_EXTERNAL.js', duration: 800 },
							{ sourceURL: 'file:///private/PRIVATE_PROJECT.js', duration: 900 },
						],
					},
				],
			});
			await vi.advanceTimersByTimeAsync(5000);
			const report = log.mock.calls.find((call) => call[2] === '[StallMonitor]')?.[3];
			expect(report).toMatchObject({
				process: 'renderer',
				attribution: 'correlated-timings',
				synchronousWork: [{ kind: 'renderer-script', name: 'view.js:slowRender@123', maxMs: 650 }],
			});
			const serialized = JSON.stringify(report);
			expect(serialized).not.toContain('PRIVATE_');
			expect(serialized).not.toContain('file:');
			expect(serialized).not.toContain('https:');
			expect(serialized).not.toContain('token=');
		} finally {
			stop?.();
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
