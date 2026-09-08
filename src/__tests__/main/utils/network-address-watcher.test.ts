/**
 * @file network-address-watcher.test.ts
 * @description Tests for src/main/utils/network-address-watcher.ts
 *
 * Covers the roaming case the watcher exists for: the machine moves between
 * networks, the web server keeps serving on 0.0.0.0, and the displayed URL has
 * to follow the new LAN address without a restart.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	createNetworkAddressWatcher,
	NETWORK_ADDRESS_POLL_INTERVAL_MS,
} from '../../../main/utils/network-address-watcher';

describe('main/utils/network-address-watcher', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function setup(options: { fingerprint: string; address: string }) {
		const readFingerprint = vi.fn(() => options.fingerprint);
		const resolveAddress = vi.fn(async () => options.address);
		const onChange = vi.fn();
		const onLog = vi.fn();

		const watcher = createNetworkAddressWatcher({
			initialAddress: '192.168.1.10',
			onChange,
			onLog,
			readFingerprint,
			resolveAddress,
		});

		const moveTo = (fingerprint: string, address: string) => {
			options.fingerprint = fingerprint;
			options.address = address;
		};

		return { watcher, readFingerprint, resolveAddress, onChange, onLog, moveTo };
	}

	it('should report no change while the interfaces stay put', async () => {
		const { watcher, onChange, resolveAddress } = setup({
			fingerprint: 'en0=192.168.1.10',
			address: '192.168.1.10',
		});

		await expect(watcher.check()).resolves.toBeNull();
		expect(onChange).not.toHaveBeenCalled();
		// The expensive route lookup must not run on an unchanged fingerprint.
		expect(resolveAddress).not.toHaveBeenCalled();
		expect(watcher.currentAddress()).toBe('192.168.1.10');
	});

	it('should resolve and report the new address after a network switch', async () => {
		const { watcher, onChange, onLog, moveTo } = setup({
			fingerprint: 'en0=192.168.1.10',
			address: '192.168.1.10',
		});

		moveTo('en0=172.20.10.3', '172.20.10.3');

		await expect(watcher.check()).resolves.toEqual({
			previousAddress: '192.168.1.10',
			address: '172.20.10.3',
		});
		expect(onChange).toHaveBeenCalledWith({
			previousAddress: '192.168.1.10',
			address: '172.20.10.3',
		});
		expect(watcher.currentAddress()).toBe('172.20.10.3');
		expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('172.20.10.3'));
	});

	it('should stay quiet when interfaces churn but the routed address does not', async () => {
		const { watcher, onChange, moveTo } = setup({
			fingerprint: 'en0=192.168.1.10',
			address: '192.168.1.10',
		});

		// A VPN or virtual interface came up; the route to the LAN is unchanged.
		moveTo('en0=192.168.1.10,utun3=10.8.0.2', '192.168.1.10');

		await expect(watcher.check()).resolves.toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it('should retry on the next tick when the address cannot be resolved', async () => {
		let fingerprint = 'en0=192.168.1.10';
		const readFingerprint = vi.fn(() => fingerprint);
		const resolveAddress = vi
			.fn()
			.mockRejectedValueOnce(new Error('no route'))
			.mockResolvedValueOnce('172.20.10.3');
		const onChange = vi.fn();
		const onLog = vi.fn();

		const watcher = createNetworkAddressWatcher({
			initialAddress: '192.168.1.10',
			onChange,
			onLog,
			readFingerprint,
			resolveAddress,
		});

		fingerprint = 'en0=172.20.10.3';

		await expect(watcher.check()).resolves.toBeNull();
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('no route'));
		expect(onChange).not.toHaveBeenCalled();

		// Fingerprint is unchanged, so only the dropped-fingerprint re-arm makes
		// this second pass look again rather than treating the failure as current.
		await watcher.check();
		expect(onChange).toHaveBeenCalledWith({
			previousAddress: '192.168.1.10',
			address: '172.20.10.3',
		});
	});

	it('should coalesce overlapping checks into one pass', async () => {
		let fingerprint = 'en0=192.168.1.10';
		const readFingerprint = vi.fn(() => fingerprint);
		let release: (value: string) => void = () => {};
		const resolveAddress = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				})
		);

		const watcher = createNetworkAddressWatcher({
			initialAddress: '192.168.1.10',
			readFingerprint,
			resolveAddress,
		});

		fingerprint = 'en0=172.20.10.3';

		const first = watcher.check();
		const second = watcher.check();
		release('172.20.10.3');

		await Promise.all([first, second]);
		expect(resolveAddress).toHaveBeenCalledTimes(1);
	});

	it('should poll on the interval once started and stop when told to', async () => {
		const { watcher, readFingerprint } = setup({
			fingerprint: 'en0=192.168.1.10',
			address: '192.168.1.10',
		});

		// One read already happened at construction, to seed the baseline.
		watcher.start();
		expect(readFingerprint).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(NETWORK_ADDRESS_POLL_INTERVAL_MS * 2);
		expect(readFingerprint).toHaveBeenCalledTimes(3);

		watcher.stop();
		await vi.advanceTimersByTimeAsync(NETWORK_ADDRESS_POLL_INTERVAL_MS * 3);
		expect(readFingerprint).toHaveBeenCalledTimes(3);
	});

	it('should not stack timers when started twice', async () => {
		const { watcher, readFingerprint } = setup({
			fingerprint: 'en0=192.168.1.10',
			address: '192.168.1.10',
		});

		watcher.start();
		watcher.start();

		// One construction read plus exactly one tick, not two.
		await vi.advanceTimersByTimeAsync(NETWORK_ADDRESS_POLL_INTERVAL_MS);
		expect(readFingerprint).toHaveBeenCalledTimes(2);
		watcher.stop();
	});
});
