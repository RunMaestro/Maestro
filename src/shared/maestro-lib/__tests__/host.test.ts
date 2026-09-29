import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fresh module per test: the host keeps its registrations in module state.
async function loadHost() {
	vi.resetModules();
	return import('../host');
}

describe('maestro-lib host', () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it('defaults to a silent logger, no-op reporters, no snapshot, and unresolvable image refs', async () => {
		const host = await loadHost();

		expect(() => host.logger.warn('x', 'ctx', { a: 1 })).not.toThrow();
		await expect(host.captureException(new Error('boom'))).resolves.toBeUndefined();
		await expect(host.captureMessage('m', 'warning')).resolves.toBeUndefined();
		expect(host.getCapabilitySnapshot('codex')).toBeUndefined();
		expect(host.resolveImageRef('maestro-image://store/abc.png')).toBeNull();
	});

	it('forwards to whatever is registered at call time, even through a logger captured earlier', async () => {
		const host = await loadHost();
		const captured = host.logger;
		const sink = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

		host.setMaestroLibLogger(sink);
		captured.info('hello', 'ctx', { n: 1 });

		expect(sink.info).toHaveBeenCalledWith('hello', 'ctx', { n: 1 });
	});

	it('forwards exactly the arguments given, so the reporter applies its own defaults', async () => {
		const host = await loadHost();
		const reporter = { captureException: vi.fn(), captureMessage: vi.fn() };
		host.setMaestroLibErrorReporter(reporter);

		const err = new Error('x');
		await host.captureException(err, { op: 'probe' });
		await host.captureMessage('m');

		expect(reporter.captureException).toHaveBeenCalledWith(err, { op: 'probe' });
		expect(reporter.captureMessage).toHaveBeenCalledWith('m');
	});

	it('resolves a maestro-image ref through the registered store in parseDataUrl', async () => {
		const host = await loadHost();
		const { parseDataUrl } = await import('../launch/image-refs');

		expect(parseDataUrl('maestro-image://store/abc.png')).toBeNull();

		host.setMaestroLibImageRefResolver(() => ({
			buffer: Buffer.from('png-bytes'),
			mediaType: 'image/png',
		}));
		expect(parseDataUrl('maestro-image://store/abc.png')).toEqual({
			mediaType: 'image/png',
			base64: Buffer.from('png-bytes').toString('base64'),
		});
		// An inline data URL never consults the host.
		expect(parseDataUrl('data:image/jpeg;base64,QUJD')).toEqual({
			mediaType: 'image/jpeg',
			base64: 'QUJD',
		});
	});

	it('answers capability lookups from the registered snapshot source', async () => {
		const host = await loadHost();
		const snapshot = { agentId: 'codex' } as never;
		const lookup = vi.fn(() => snapshot);
		host.setMaestroLibCapabilitySnapshotLookup(lookup);

		expect(host.getCapabilitySnapshot('codex', 'remote-1')).toBe(snapshot);
		expect(lookup).toHaveBeenCalledWith('codex', 'remote-1');
	});
});
