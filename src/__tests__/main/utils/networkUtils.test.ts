/**
 * @file networkUtils.test.ts
 * @description Tests for src/main/utils/networkUtils.ts
 *
 * Tests network utilities for IP address detection including:
 * - getLocalIpAddress (async with UDP socket)
 * - getLocalIpAddressSync (interface scanning)
 * - Private IP detection
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create mocks that can be used in vi.mock
const { mockNetworkInterfaces, mockCreateSocket } = vi.hoisted(() => ({
	mockNetworkInterfaces: vi.fn(),
	mockCreateSocket: vi.fn(),
}));

// Mock the os module
vi.mock('os', () => ({
	default: { networkInterfaces: mockNetworkInterfaces },
	networkInterfaces: mockNetworkInterfaces,
}));

// Mock the dgram module
vi.mock('dgram', () => ({
	default: { createSocket: mockCreateSocket },
	createSocket: mockCreateSocket,
}));

import * as networkUtils from '../../../main/utils/networkUtils';

describe('main/utils/networkUtils', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ===========================================
	// getLocalIpAddress (async)
	// ===========================================
	describe('getLocalIpAddress', () => {
		it('should return IP from UDP socket when successful', async () => {
			const mockSocket = {
				on: vi.fn(),
				connect: vi.fn((port, host, callback) => {
					// Simulate successful connection
					callback();
				}),
				address: vi.fn().mockReturnValue({ address: '192.168.1.100' }),
				close: vi.fn(),
				removeAllListeners: vi.fn(),
			};
			mockCreateSocket.mockReturnValue(mockSocket as any);

			const result = await networkUtils.getLocalIpAddress();
			expect(result).toBe('192.168.1.100');
			expect(mockCreateSocket).toHaveBeenCalledWith('udp4');
		});

		it('should fall back to interface scanning when UDP returns 127.0.0.1', async () => {
			const mockSocket = {
				on: vi.fn(),
				connect: vi.fn((port, host, callback) => {
					callback();
				}),
				address: vi.fn().mockReturnValue({ address: '127.0.0.1' }),
				close: vi.fn(),
				removeAllListeners: vi.fn(),
			};
			mockCreateSocket.mockReturnValue(mockSocket as any);

			// Set up interface scanning fallback
			mockNetworkInterfaces.mockReturnValue({
				en0: [
					{
						address: '192.168.1.50',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.50/24',
					},
				],
			});

			const result = await networkUtils.getLocalIpAddress();
			expect(result).toBe('192.168.1.50');
		});

		it('should fall back to interface scanning when UDP socket errors', async () => {
			const mockSocket = {
				on: vi.fn((event, handler) => {
					if (event === 'error') {
						// Trigger error immediately
						setTimeout(() => handler(new Error('Socket error')), 0);
					}
				}),
				connect: vi.fn(),
				close: vi.fn(),
				removeAllListeners: vi.fn(),
			};
			mockCreateSocket.mockReturnValue(mockSocket as any);

			mockNetworkInterfaces.mockReturnValue({
				eth0: [
					{
						address: '10.0.0.5',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.0.0.5/8',
					},
				],
			});

			const result = await networkUtils.getLocalIpAddress();
			expect(result).toBe('10.0.0.5');
		});

		it('should handle UDP socket address() throwing error', async () => {
			const mockSocket = {
				on: vi.fn(),
				connect: vi.fn((port, host, callback) => {
					callback();
				}),
				address: vi.fn().mockImplementation(() => {
					throw new Error('Address error');
				}),
				close: vi.fn(),
				removeAllListeners: vi.fn(),
			};
			mockCreateSocket.mockReturnValue(mockSocket as any);

			mockNetworkInterfaces.mockReturnValue({
				en0: [
					{
						address: '172.16.0.10',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.16.0.10/16',
					},
				],
			});

			const result = await networkUtils.getLocalIpAddress();
			expect(result).toBe('172.16.0.10');
		});

		it('should handle UDP socket close() throwing error', async () => {
			const mockSocket = {
				on: vi.fn(),
				connect: vi.fn((port, host, callback) => {
					callback();
				}),
				address: vi.fn().mockReturnValue({ address: '192.168.1.100' }),
				close: vi.fn().mockImplementation(() => {
					throw new Error('Close error');
				}),
				removeAllListeners: vi.fn(),
			};
			mockCreateSocket.mockReturnValue(mockSocket as any);

			// Should still return the IP despite close error
			const result = await networkUtils.getLocalIpAddress();
			expect(result).toBe('192.168.1.100');
		});
	});

	// ===========================================
	// getLocalIpAddressSync
	// ===========================================
	describe('getLocalIpAddressSync', () => {
		it('should return localhost when no interfaces available', () => {
			mockNetworkInterfaces.mockReturnValue({});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('localhost');
		});

		it('should skip internal interfaces', () => {
			mockNetworkInterfaces.mockReturnValue({
				lo0: [
					{
						address: '127.0.0.1',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: true,
						cidr: '127.0.0.1/8',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('localhost');
		});

		it('should skip IPv6 addresses', () => {
			mockNetworkInterfaces.mockReturnValue({
				en0: [
					{
						address: 'fe80::1',
						netmask: 'ffff:ffff:ffff:ffff::',
						family: 'IPv6',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: 'fe80::1/64',
						scopeid: 1,
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('localhost');
		});

		it('should skip 127.0.0.1 addresses', () => {
			mockNetworkInterfaces.mockReturnValue({
				lo0: [
					{
						address: '127.0.0.1',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false, // Even if not marked internal
						cidr: '127.0.0.1/8',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('localhost');
		});

		it('should prioritize Ethernet interfaces (en0, eth0)', () => {
			mockNetworkInterfaces.mockReturnValue({
				veth0: [
					{
						address: '172.17.0.1',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.17.0.1/16',
					},
				],
				en0: [
					{
						address: '192.168.1.10',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.10/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.1.10');
		});

		it('should prioritize WiFi interfaces over virtual', () => {
			mockNetworkInterfaces.mockReturnValue({
				docker0: [
					{
						address: '172.17.0.1',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.17.0.1/16',
					},
				],
				wlan0: [
					{
						address: '192.168.1.20',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.20/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.1.20');
		});

		it('should handle bridge interfaces with medium priority', () => {
			mockNetworkInterfaces.mockReturnValue({
				docker0: [
					{
						address: '172.17.0.1',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.17.0.1/16',
					},
				],
				bridge0: [
					{
						address: '192.168.2.1',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.2.1/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.2.1');
		});

		it('should give lower priority to virtual interfaces (veth, docker, vmnet, vbox, tun, tap)', () => {
			mockNetworkInterfaces.mockReturnValue({
				veth123: [
					{
						address: '172.17.0.2',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.17.0.2/16',
					},
				],
				unknown0: [
					{
						address: '10.0.0.50',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.0.0.50/8',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			// unknown0 has priority 30+5 (other + private), veth123 has 10+5
			expect(result).toBe('10.0.0.50');
		});

		it('should prefer private IP ranges', () => {
			mockNetworkInterfaces.mockReturnValue({
				unknown0: [
					{
						address: '8.8.8.8', // Public IP (unlikely but for test)
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '8.8.8.8/8',
					},
				],
				unknown1: [
					{
						address: '192.168.1.5', // Private IP
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.5/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			// Both are "other" interfaces (priority 30), but 192.168.1.5 gets +5 for private
			expect(result).toBe('192.168.1.5');
		});

		it('should handle undefined interface addresses', () => {
			mockNetworkInterfaces.mockReturnValue({
				en0: undefined as any,
				en1: [
					{
						address: '192.168.1.100',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.100/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.1.100');
		});

		it('should handle eth interfaces similar to en interfaces', () => {
			mockNetworkInterfaces.mockReturnValue({
				eth0: [
					{
						address: '10.0.0.100',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.0.0.100/8',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('10.0.0.100');
		});

		it('should handle WiFi interface name variations', () => {
			mockNetworkInterfaces.mockReturnValue({
				WiFi: [
					{
						address: '192.168.0.50',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.0.50/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.0.50');
		});

		it('should handle wl interface prefix', () => {
			mockNetworkInterfaces.mockReturnValue({
				wlp3s0: [
					{
						address: '192.168.0.60',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.0.60/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.0.60');
		});

		it('should handle multiple interfaces with multiple addresses', () => {
			mockNetworkInterfaces.mockReturnValue({
				en0: [
					{
						address: 'fe80::1',
						netmask: 'ffff:ffff:ffff:ffff::',
						family: 'IPv6',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: 'fe80::1/64',
						scopeid: 4,
					},
					{
						address: '192.168.1.200',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.200/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.1.200');
		});
	});

	// ===========================================
	// Private IP Detection (tested via behavior)
	// ===========================================
	describe('private IP detection', () => {
		it('should recognize 10.x.x.x as private', () => {
			mockNetworkInterfaces.mockReturnValue({
				unknown0: [
					{
						address: '10.0.0.1',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.0.0.1/8',
					},
				],
				unknown1: [
					{
						address: '11.0.0.1', // Not private
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '11.0.0.1/8',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('10.0.0.1');
		});

		it('should recognize 172.16-31.x.x as private', () => {
			mockNetworkInterfaces.mockReturnValue({
				unknown0: [
					{
						address: '172.16.0.1',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.16.0.1/16',
					},
				],
				unknown1: [
					{
						address: '172.15.0.1', // Not in private range
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.15.0.1/16',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('172.16.0.1');
		});

		it('should recognize 172.31.x.x as private', () => {
			mockNetworkInterfaces.mockReturnValue({
				unknown0: [
					{
						address: '172.31.255.255',
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.31.255.255/16',
					},
				],
				unknown1: [
					{
						address: '172.32.0.1', // Not in private range
						netmask: '255.255.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '172.32.0.1/16',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('172.31.255.255');
		});

		it('should recognize 192.168.x.x as private', () => {
			mockNetworkInterfaces.mockReturnValue({
				unknown0: [
					{
						address: '192.168.0.1',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.0.1/24',
					},
				],
				unknown1: [
					{
						address: '192.169.0.1', // Not private
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.169.0.1/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.0.1');
		});
	});

	// ===========================================
	// Edge Cases
	// ===========================================
	describe('edge cases', () => {
		it('should handle empty interface arrays', () => {
			mockNetworkInterfaces.mockReturnValue({
				en0: [],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('localhost');
		});

		it('should handle vmnet interfaces (VMware)', () => {
			mockNetworkInterfaces.mockReturnValue({
				vmnet1: [
					{
						address: '192.168.100.1',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.100.1/24',
					},
				],
				unknown0: [
					{
						address: '10.0.0.5',
						netmask: '255.0.0.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.0.0.5/8',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			// vmnet gets priority 10+5=15, unknown0 gets 30+5=35
			expect(result).toBe('10.0.0.5');
		});

		it('should handle VirtualBox interfaces', () => {
			mockNetworkInterfaces.mockReturnValue({
				vboxnet0: [
					{
						address: '192.168.56.1',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.56.1/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			expect(result).toBe('192.168.56.1'); // Still returned, just lower priority
		});

		it('should handle tun/tap interfaces', () => {
			mockNetworkInterfaces.mockReturnValue({
				tun0: [
					{
						address: '10.8.0.1',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.8.0.1/24',
					},
				],
				tap0: [
					{
						address: '10.9.0.1',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '10.9.0.1/24',
					},
				],
			});
			const result = networkUtils.getLocalIpAddressSync();
			// Both have same priority, result will be one of them
			expect(['10.8.0.1', '10.9.0.1']).toContain(result);
		});
	});

	// ===========================================
	// Integration Tests
	// ===========================================
	describe('integration', () => {
		it('getLocalIpAddress should call getLocalIpAddressSync as fallback', async () => {
			// Make UDP fail
			const mockSocket = {
				on: vi.fn((event, handler) => {
					if (event === 'error') {
						setTimeout(() => handler(new Error('UDP error')), 0);
					}
				}),
				connect: vi.fn(),
				close: vi.fn(),
				removeAllListeners: vi.fn(),
			};
			mockCreateSocket.mockReturnValue(mockSocket as any);

			mockNetworkInterfaces.mockReturnValue({
				en0: [
					{
						address: '192.168.1.123',
						netmask: '255.255.255.0',
						family: 'IPv4',
						mac: '00:00:00:00:00:00',
						internal: false,
						cidr: '192.168.1.123/24',
					},
				],
			});

			const result = await networkUtils.getLocalIpAddress();
			expect(result).toBe('192.168.1.123');
		});
	});
});
