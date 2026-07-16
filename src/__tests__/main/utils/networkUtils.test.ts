/**
 * @file networkUtils.test.ts
 * @description Tests for src/main/utils/networkUtils.ts
 *
 * Covers:
 * - getLocalIpAddress (async with UDP socket and interface-scan fallback)
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

	// Integration Tests
	// ===========================================
	describe('integration', () => {
		it('getLocalIpAddress falls back to interface scanning', async () => {
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
