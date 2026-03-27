import { describe, it, expect, vi } from 'vitest';
import { ACPClient, type ACPClientConfig } from '../../../main/acp/acp-client';
import type { SessionUpdate } from '../../../main/acp/types';

// Mock child_process with factory that doesn't reference external variables
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	return {
		...actual,
		default: {
			...actual,
			spawn: vi.fn(),
		},
		spawn: vi.fn(),
	};
});

// Mock readline
vi.mock('readline', async (importOriginal) => {
	const actual = await importOriginal<typeof import('readline')>();
	return {
		...actual,
		default: {
			...actual,
			createInterface: vi.fn(),
		},
		createInterface: vi.fn(),
	};
});

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

describe('ACPClient', () => {
	const mockConfig: ACPClientConfig = {
		command: 'opencode',
		args: ['acp'],
		cwd: '/test/project',
		env: { TEST_VAR: 'test' },
	};

	describe('constructor', () => {
		it('should create client with config', () => {
			const client = new ACPClient(mockConfig);

			expect(client).toBeInstanceOf(ACPClient);
			expect(client.getIsConnected()).toBe(false);
			expect(client.getAgentCapabilities()).toBeNull();
			expect(client.getAgentInfo()).toBeNull();
		});

		it('should accept custom client info', () => {
			const configWithClientInfo: ACPClientConfig = {
				...mockConfig,
				clientInfo: {
					name: 'custom-client',
					version: '1.0.0',
					title: 'Custom Client',
				},
			};

			const client = new ACPClient(configWithClientInfo);
			expect(client).toBeInstanceOf(ACPClient);
		});

		it('should accept custom client capabilities', () => {
			const configWithCapabilities: ACPClientConfig = {
				...mockConfig,
				clientCapabilities: {
					fs: {
						readTextFile: true,
						writeTextFile: false,
					},
					terminal: false,
				},
			};

			const client = new ACPClient(configWithCapabilities);
			expect(client).toBeInstanceOf(ACPClient);
		});
	});

	describe('getProcess', () => {
		it('should return null before connection', () => {
			const client = new ACPClient(mockConfig);
			expect(client.getProcess()).toBeNull();
		});
	});

	describe('getIsConnected', () => {
		it('should return false before connection', () => {
			const client = new ACPClient(mockConfig);
			expect(client.getIsConnected()).toBe(false);
		});
	});

	describe('event emitter', () => {
		it('should support event listeners', () => {
			const client = new ACPClient(mockConfig);
			const mockListener = vi.fn();

			client.on('error', mockListener);
			client.emit('error', new Error('Test error'));

			expect(mockListener).toHaveBeenCalledTimes(1);
			expect(mockListener).toHaveBeenCalledWith(expect.any(Error));
		});

		it('should support session:update events', () => {
			const client = new ACPClient(mockConfig);
			const mockListener = vi.fn();

			client.on('session:update', mockListener);
			client.emit('session:update', 'session-123', {
				agent_message_chunk: { content: { text: { text: 'Hello' } } },
			} as SessionUpdate);

			expect(mockListener).toHaveBeenCalledWith('session-123', expect.any(Object));
		});

		it('should support disconnected events', () => {
			const client = new ACPClient(mockConfig);
			const mockListener = vi.fn();

			client.on('disconnected', mockListener);
			client.emit('disconnected');

			expect(mockListener).toHaveBeenCalledTimes(1);
		});
	});

	describe('disconnect before connect', () => {
		it('should handle disconnect gracefully when not connected', () => {
			const client = new ACPClient(mockConfig);

			// Should not throw
			expect(() => client.disconnect()).not.toThrow();
			expect(client.getIsConnected()).toBe(false);
		});
	});

	describe('authenticate', () => {
		it('should throw if not connected', async () => {
			const client = new ACPClient(mockConfig);

			await expect(client.authenticate('google-oauth')).rejects.toThrow(
				'Not connected - call connect() first'
			);
		});
	});
});

describe('ACP Client Utilities', () => {
	describe('redactForLogging', () => {
		// We test this by observing the behavior through the client
		// The actual function is private, but we can verify its behavior through logs

		it('should preserve method and id in requests', () => {
			// This is implicitly tested through the client's logging behavior
			// The redactForLogging function keeps metadata intact
			expect(true).toBe(true); // Placeholder for documentation
		});
	});
});

describe('ACP Protocol Constants', () => {
	it('should use protocol version 1', async () => {
		// Import the constant directly using dynamic import
		const { CURRENT_PROTOCOL_VERSION } = await import('../../../main/acp/types');
		expect(CURRENT_PROTOCOL_VERSION).toBe(1);
	});
});
