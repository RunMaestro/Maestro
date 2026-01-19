/**
 * Tests for SSH Remote Configuration Resolver.
 *
 * SSH is SESSION-LEVEL ONLY:
 * - Each session can have its own SSH config
 * - No agent-level or global defaults
 */

import { describe, it, expect, vi } from 'vitest';
import {
	getSshRemoteConfig,
	createSshRemoteStoreAdapter,
	SshRemoteSettingsStore,
} from '../../../main/utils/ssh-remote-resolver';
import type { SshRemoteConfig } from '../../../shared/types';

describe('getSshRemoteConfig', () => {
	// Test fixtures
	const remote1: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	const remote2: SshRemoteConfig = {
		id: 'remote-2',
		name: 'Production Server',
		host: 'prod.example.com',
		port: 22,
		username: 'admin',
		privateKeyPath: '~/.ssh/id_rsa',
		enabled: true,
	};

	const disabledRemote: SshRemoteConfig = {
		id: 'remote-disabled',
		name: 'Disabled Server',
		host: 'disabled.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: false,
	};

	/**
	 * Create a mock store with specified SSH remotes.
	 * Note: SSH is session-level only - no agent-level or global defaults.
	 */
	function createMockStore(sshRemotes: SshRemoteConfig[] = []): SshRemoteSettingsStore {
		return {
			getSshRemotes: vi.fn(() => sshRemotes),
		};
	}

	describe('when no SSH remotes are configured', () => {
		it('returns null config with source "none"', () => {
			const store = createMockStore([]);
			const result = getSshRemoteConfig(store, {});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null even with session SSH config when no remotes exist', () => {
			const store = createMockStore([]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});
	});

	describe('when no session SSH config is provided (local execution)', () => {
		it('returns null config with source "none" even when remotes exist', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {});

			// No session config = local execution (no defaults)
			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null when only disabled remotes exist', () => {
			const store = createMockStore([disabledRemote]);
			const result = getSshRemoteConfig(store, {});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});
	});

	describe('when using session-specific SSH remote config', () => {
		it('returns session config with source "session" when enabled', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-2' },
			});

			expect(result.config).toEqual(remote2);
			expect(result.source).toBe('session');
		});

		it('returns null with source "disabled" when session SSH is explicitly disabled', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: false, remoteId: null },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('disabled');
		});

		it('returns session config when matching remote ID', () => {
			const store = createMockStore([remote1]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
			});

			expect(result.config).toEqual(remote1);
			expect(result.source).toBe('session');
		});

		it('returns null with source "none" when session remote ID not found', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'non-existent' },
			});

			// Remote not found = local execution
			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null with source "none" when session remote is disabled', () => {
			const store = createMockStore([remote1, disabledRemote]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-disabled' },
			});

			// Remote disabled = local execution
			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});

		it('returns null when session enabled but no remoteId specified', () => {
			const store = createMockStore([remote1]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: null },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('none');
		});
	});

	describe('priority ordering', () => {
		it('session-specific disabled takes precedence (returns disabled source)', () => {
			const store = createMockStore([remote1]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: false, remoteId: null },
			});

			expect(result.config).toBeNull();
			expect(result.source).toBe('disabled');
		});

		it('session-specific remote is used when valid', () => {
			const store = createMockStore([remote1, remote2]);
			const result = getSshRemoteConfig(store, {
				sessionSshConfig: { enabled: true, remoteId: 'remote-2' },
			});

			expect(result.config).toEqual(remote2);
			expect(result.source).toBe('session');
		});
	});
});

describe('createSshRemoteStoreAdapter', () => {
	const remote1: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	it('creates adapter that delegates to store.get for sshRemotes', () => {
		const mockGet = vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [remote1];
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const remotes = adapter.getSshRemotes();

		expect(remotes).toEqual([remote1]);
		expect(mockGet).toHaveBeenCalledWith('sshRemotes', []);
	});

	it('returns empty array for sshRemotes when not set', () => {
		const mockGet = vi.fn().mockImplementation((_key: string, defaultValue: unknown) => {
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const remotes = adapter.getSshRemotes();

		expect(remotes).toEqual([]);
	});
});

describe('integration with getSshRemoteConfig', () => {
	const remote1: SshRemoteConfig = {
		id: 'remote-1',
		name: 'Dev Server',
		host: 'dev.example.com',
		port: 22,
		username: 'user',
		privateKeyPath: '~/.ssh/id_ed25519',
		enabled: true,
	};

	it('works end-to-end with store adapter and session config', () => {
		const mockGet = vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [remote1];
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const result = getSshRemoteConfig(adapter, {
			sessionSshConfig: { enabled: true, remoteId: 'remote-1' },
		});

		expect(result.config).toEqual(remote1);
		expect(result.source).toBe('session');
	});

	it('returns null for local execution when no session config', () => {
		const mockGet = vi.fn().mockImplementation((key: string, defaultValue: unknown) => {
			if (key === 'sshRemotes') return [remote1];
			return defaultValue;
		});
		const mockStore = { get: mockGet };

		const adapter = createSshRemoteStoreAdapter(mockStore);
		const result = getSshRemoteConfig(adapter, {});

		// No session config = local execution
		expect(result.config).toBeNull();
		expect(result.source).toBe('none');
	});
});
