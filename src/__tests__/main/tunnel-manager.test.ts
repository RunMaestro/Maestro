/**
 * @file tunnel-manager.test.ts
 * @description Tests for the TunnelManager class
 *
 * TunnelManager manages cloudflared tunnels for exposing local servers:
 * - start(port) - starts a tunnel on the specified port
 * - stop() - stops the running tunnel
 * - getStatus() - returns the current tunnel status
 *
 * Note: Tests for async operations involving URLs and events are in separate
 * test files with proper timeout handling. This file focuses on synchronous
 * and fast-resolving tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Create mock functions using vi.hoisted
const mocks = vi.hoisted(() => ({
	mockSpawn: vi.fn(),
	mockIsCloudflaredInstalled: vi.fn(),
	mockGetCloudflaredPath: vi.fn(),
	mockLoggerInfo: vi.fn(),
	mockLoggerError: vi.fn(),
}));

// Mock child_process using dynamic import for the original
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: {
			...actual,
			spawn: mocks.mockSpawn,
		},
		spawn: mocks.mockSpawn,
	};
});

// Mock logger
vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: mocks.mockLoggerInfo,
		error: mocks.mockLoggerError,
	},
}));

// Mock cliDetection
vi.mock('../../main/utils/cliDetection', () => ({
	isCloudflaredInstalled: mocks.mockIsCloudflaredInstalled,
	getCloudflaredPath: mocks.mockGetCloudflaredPath,
}));

// Helper to create a mock ChildProcess
const createMockProcess = () => {
	const process = new EventEmitter() as EventEmitter & {
		stderr: EventEmitter;
		stdout: EventEmitter;
		killed: boolean;
		kill: ReturnType<typeof vi.fn>;
	};
	process.stderr = new EventEmitter();
	process.stdout = new EventEmitter();
	process.kill = vi.fn();
	process.killed = false;
	return process;
};

describe('TunnelManager', () => {
	let tunnelManager: typeof import('../../main/tunnel-manager').tunnelManager;
	let mockProcess: ReturnType<typeof createMockProcess>;

	beforeEach(async () => {
		vi.clearAllMocks();

		// Reset module to get fresh TunnelManager instance
		vi.resetModules();

		// Default mock setup
		mockProcess = createMockProcess();
		mocks.mockSpawn.mockReturnValue(mockProcess);
		mocks.mockIsCloudflaredInstalled.mockResolvedValue(true);
		mocks.mockGetCloudflaredPath.mockReturnValue('/usr/local/bin/cloudflared');

		// Import fresh module
		const module = await import('../../main/tunnel-manager');
		tunnelManager = module.tunnelManager;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	// =============================================================================
	// GETSTATUS TESTS
	// =============================================================================

	describe('getStatus', () => {
		it('returns initial status when no tunnel is running', () => {
			const status = tunnelManager.getStatus();

			expect(status).toEqual({
				isRunning: false,
				url: null,
				error: null,
			});
		});

		it('TunnelStatus has correct properties', () => {
			const status = tunnelManager.getStatus();

			expect(status).toHaveProperty('isRunning');
			expect(status).toHaveProperty('url');
			expect(status).toHaveProperty('error');
			expect(typeof status.isRunning).toBe('boolean');
		});
	});

	// =============================================================================
	// START PORT VALIDATION TESTS
	// =============================================================================

	describe('start - port validation', () => {
		it('rejects negative port', async () => {
			const result = await tunnelManager.start(-1);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid port number');
			expect(result.error).toContain('-1');
		});

		it('rejects port 0', async () => {
			const result = await tunnelManager.start(0);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid port number');
		});

		it('rejects port > 65535', async () => {
			const result = await tunnelManager.start(65536);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid port number');
		});

		it('rejects port 100000', async () => {
			const result = await tunnelManager.start(100000);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid port number');
		});

		it('rejects non-integer port 3000.5', async () => {
			const result = await tunnelManager.start(3000.5);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid port number');
		});

		it('rejects non-integer port 1.1', async () => {
			const result = await tunnelManager.start(1.1);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid port number');
		});

		it('TunnelResult error shape on invalid port', async () => {
			const result = await tunnelManager.start(-1);

			expect(result).toHaveProperty('success', false);
			expect(result).toHaveProperty('error');
			expect(typeof result.error).toBe('string');
			expect(result.url).toBeUndefined();
		});
	});

	// =============================================================================
	// START CLOUDFLARED DETECTION TESTS
	// =============================================================================

	describe('start - cloudflared detection', () => {
		it('returns error when cloudflared is not installed', async () => {
			mocks.mockIsCloudflaredInstalled.mockResolvedValue(false);

			const result = await tunnelManager.start(3000);

			expect(result.success).toBe(false);
			expect(result.error).toBe('cloudflared is not installed');
		});

		it('checks cloudflared installation before spawning', async () => {
			mocks.mockIsCloudflaredInstalled.mockResolvedValue(false);

			await tunnelManager.start(3000);

			expect(mocks.mockIsCloudflaredInstalled).toHaveBeenCalled();
			// Should NOT spawn when cloudflared is not installed
			expect(mocks.mockSpawn).not.toHaveBeenCalled();
		});
	});

	// =============================================================================
	// SPAWN CONFIGURATION TESTS
	// Note: These tests verify spawn is called correctly by waiting for the
	// async cloudflared installation check to complete first.
	// =============================================================================

	describe('start - spawn configuration', () => {
		it('spawns cloudflared with correct binary path', async () => {
			mocks.mockGetCloudflaredPath.mockReturnValue('/custom/path/cloudflared');

			// Start and let the async cloudflared check complete
			const promise = tunnelManager.start(3000);

			// Give time for the async isCloudflaredInstalled to resolve
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockSpawn).toHaveBeenCalledWith('/custom/path/cloudflared', expect.any(Array));

			// Clean up by emitting exit (don't wait for it)
			mockProcess.emit('exit', 0);
		});

		it('uses default cloudflared when path is null', async () => {
			mocks.mockGetCloudflaredPath.mockReturnValue(null);

			tunnelManager.start(3000);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockSpawn).toHaveBeenCalledWith('cloudflared', expect.any(Array));

			mockProcess.emit('exit', 0);
		});

		it('spawns with tunnel command', async () => {
			tunnelManager.start(3000);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockSpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining(['tunnel'])
			);

			mockProcess.emit('exit', 0);
		});

		it('spawns with --url argument', async () => {
			tunnelManager.start(3000);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockSpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining(['--url'])
			);

			mockProcess.emit('exit', 0);
		});

		it('passes localhost URL with correct port', async () => {
			tunnelManager.start(8080);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockSpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining(['http://localhost:8080'])
			);

			mockProcess.emit('exit', 0);
		});

		it('passes different ports correctly', async () => {
			tunnelManager.start(9000);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockSpawn).toHaveBeenCalledWith(
				expect.any(String),
				expect.arrayContaining(['http://localhost:9000'])
			);

			mockProcess.emit('exit', 0);
		});

		it('logs start message', async () => {
			tunnelManager.start(3000);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
				expect.stringContaining('Starting cloudflared tunnel for port 3000'),
				'TunnelManager'
			);

			mockProcess.emit('exit', 0);
		});

		it('logs binary path in start message', async () => {
			mocks.mockGetCloudflaredPath.mockReturnValue('/custom/cloudflared');

			tunnelManager.start(3000);
			await new Promise((resolve) => setImmediate(resolve));

			expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
				expect.stringContaining('/custom/cloudflared'),
				'TunnelManager'
			);

			mockProcess.emit('exit', 0);
		});
	});

	// =============================================================================
	// INTERFACE EXPORTS
	// =============================================================================

	describe('exports', () => {
		it('exports tunnelManager singleton', async () => {
			const module = await import('../../main/tunnel-manager');
			expect(module.tunnelManager).toBeDefined();
			expect(typeof module.tunnelManager.start).toBe('function');
			expect(typeof module.tunnelManager.stop).toBe('function');
			expect(typeof module.tunnelManager.getStatus).toBe('function');
		});

		it('TunnelStatus interface shape from getStatus', () => {
			const status = tunnelManager.getStatus();

			// Verify all expected properties exist
			expect('isRunning' in status).toBe(true);
			expect('url' in status).toBe(true);
			expect('error' in status).toBe(true);
		});
	});
});
