import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AccountRegistry } from '../../../main/accounts/account-registry';
import type { AccountUsageStatsProvider } from '../../../main/accounts/account-registry';
import type { AccountStoreData } from '../../../main/stores/account-store-types';
import { ACCOUNT_SWITCH_DEFAULTS } from '../../../shared/account-types';

// Create a mock store that behaves like electron-store (in-memory)
function createMockStore(initial?: Partial<AccountStoreData>) {
	const data: AccountStoreData = {
		accounts: {},
		assignments: {},
		switchConfig: { ...ACCOUNT_SWITCH_DEFAULTS },
		rotationOrder: [],
		rotationIndex: 0,
		...initial,
	};

	return {
		get(key: string, defaultValue?: any) {
			return (data as any)[key] ?? defaultValue;
		},
		set(key: string, value: any) {
			(data as any)[key] = value;
		},
		_data: data,
	} as any;
}

function makeParams(overrides: Partial<{ name: string; email: string; configDir: string }> = {}) {
	return {
		name: overrides.name ?? 'Test Account',
		email: overrides.email ?? 'test@example.com',
		configDir: overrides.configDir ?? '/home/user/.claude-test',
		...overrides,
	};
}

describe('AccountRegistry', () => {
	let store: ReturnType<typeof createMockStore>;
	let registry: AccountRegistry;

	beforeEach(() => {
		store = createMockStore();
		registry = new AccountRegistry(store);
	});

	describe('add', () => {
		it('should create a new account with default values', () => {
			const profile = registry.add(makeParams());

			expect(profile.id).toBeTruthy();
			expect(profile.name).toBe('Test Account');
			expect(profile.email).toBe('test@example.com');
			expect(profile.configDir).toBe('/home/user/.claude-test');
			expect(profile.agentType).toBe('claude-code');
			expect(profile.status).toBe('active');
			expect(profile.authMethod).toBe('oauth');
			expect(profile.isDefault).toBe(true); // First account is default
			expect(profile.autoSwitchEnabled).toBe(true);
			expect(profile.lastUsedAt).toBe(0);
			expect(profile.lastThrottledAt).toBe(0);
			expect(profile.tokenLimitPerWindow).toBe(0);
		});

		it('should mark only the first account as default', () => {
			const first = registry.add(makeParams({ email: 'first@example.com' }));
			const second = registry.add(makeParams({ email: 'second@example.com' }));

			expect(first.isDefault).toBe(true);
			expect(second.isDefault).toBe(false);
		});

		it('should throw on duplicate email', () => {
			registry.add(makeParams({ email: 'dupe@example.com' }));

			expect(() => registry.add(makeParams({ email: 'dupe@example.com' }))).toThrow(
				'Account with email "dupe@example.com" already exists'
			);
		});

		it('should add account to rotation order', () => {
			const profile = registry.add(makeParams());

			const order = store.get('rotationOrder');
			expect(order).toContain(profile.id);
		});

		it('should accept custom agentType and authMethod', () => {
			const profile = registry.add({
				...makeParams(),
				agentType: 'claude-code',
				authMethod: 'api-key',
			});

			expect(profile.agentType).toBe('claude-code');
			expect(profile.authMethod).toBe('api-key');
		});
	});

	describe('get / getAll', () => {
		it('should return null for non-existent ID', () => {
			expect(registry.get('nonexistent')).toBeNull();
		});

		it('should return the account by ID', () => {
			const added = registry.add(makeParams());

			expect(registry.get(added.id)).toEqual(added);
		});

		it('should return all accounts', () => {
			registry.add(makeParams({ email: 'a@example.com' }));
			registry.add(makeParams({ email: 'b@example.com' }));

			expect(registry.getAll()).toHaveLength(2);
		});
	});

	describe('findByEmail / findByConfigDir', () => {
		it('should find account by email', () => {
			const added = registry.add(makeParams({ email: 'find@example.com' }));

			expect(registry.findByEmail('find@example.com')?.id).toBe(added.id);
			expect(registry.findByEmail('notfound@example.com')).toBeNull();
		});

		it('should find account by configDir', () => {
			const added = registry.add(makeParams({ configDir: '/home/user/.claude-special' }));

			expect(registry.findByConfigDir('/home/user/.claude-special')?.id).toBe(added.id);
			expect(registry.findByConfigDir('/nonexistent')).toBeNull();
		});
	});

	describe('update', () => {
		it('should return null for non-existent ID', () => {
			expect(registry.update('nonexistent', { name: 'Updated' })).toBeNull();
		});

		it('should update account fields', () => {
			const added = registry.add(makeParams());
			const updated = registry.update(added.id, { name: 'New Name' });

			expect(updated?.name).toBe('New Name');
			expect(updated?.email).toBe('test@example.com'); // unchanged
		});

		it('should clear default from other accounts when setting new default', () => {
			const first = registry.add(makeParams({ email: 'a@example.com' }));
			registry.add(makeParams({ email: 'b@example.com' }));
			const second = registry.getAll().find(a => a.email === 'b@example.com')!;

			registry.update(second.id, { isDefault: true });

			expect(registry.get(first.id)?.isDefault).toBe(false);
			expect(registry.get(second.id)?.isDefault).toBe(true);
		});
	});

	describe('remove', () => {
		it('should return false for non-existent ID', () => {
			expect(registry.remove('nonexistent')).toBe(false);
		});

		it('should remove account and clean up rotation order', () => {
			const added = registry.add(makeParams());

			expect(registry.remove(added.id)).toBe(true);
			expect(registry.get(added.id)).toBeNull();
			expect(store.get('rotationOrder')).not.toContain(added.id);
		});

		it('should remove assignments pointing to the deleted account', () => {
			const added = registry.add(makeParams());
			registry.assignToSession('session-1', added.id);

			registry.remove(added.id);

			expect(registry.getAssignment('session-1')).toBeNull();
		});
	});

	describe('setStatus', () => {
		it('should update account status', () => {
			const added = registry.add(makeParams());

			registry.setStatus(added.id, 'disabled');

			expect(registry.get(added.id)?.status).toBe('disabled');
		});

		it('should set lastThrottledAt when throttled', () => {
			const added = registry.add(makeParams());
			const before = Date.now();

			registry.setStatus(added.id, 'throttled');

			const account = registry.get(added.id)!;
			expect(account.status).toBe('throttled');
			expect(account.lastThrottledAt).toBeGreaterThanOrEqual(before);
		});

		it('should no-op for non-existent ID', () => {
			// Should not throw
			registry.setStatus('nonexistent', 'active');
		});
	});

	describe('touchLastUsed', () => {
		it('should update lastUsedAt timestamp', () => {
			const added = registry.add(makeParams());
			expect(registry.get(added.id)?.lastUsedAt).toBe(0);

			const before = Date.now();
			registry.touchLastUsed(added.id);

			expect(registry.get(added.id)?.lastUsedAt).toBeGreaterThanOrEqual(before);
		});
	});

	describe('assignments', () => {
		it('should assign account to session', () => {
			const added = registry.add(makeParams());
			const assignment = registry.assignToSession('session-1', added.id);

			expect(assignment.sessionId).toBe('session-1');
			expect(assignment.accountId).toBe(added.id);
			expect(assignment.assignedAt).toBeGreaterThan(0);
		});

		it('should get assignment by session ID', () => {
			const added = registry.add(makeParams());
			registry.assignToSession('session-1', added.id);

			const assignment = registry.getAssignment('session-1');
			expect(assignment?.accountId).toBe(added.id);
		});

		it('should return null for unassigned session', () => {
			expect(registry.getAssignment('unknown')).toBeNull();
		});

		it('should remove assignment', () => {
			const added = registry.add(makeParams());
			registry.assignToSession('session-1', added.id);

			registry.removeAssignment('session-1');

			expect(registry.getAssignment('session-1')).toBeNull();
		});

		it('should get all assignments', () => {
			const added = registry.add(makeParams());
			registry.assignToSession('session-1', added.id);
			registry.assignToSession('session-2', added.id);

			expect(registry.getAllAssignments()).toHaveLength(2);
		});

		it('should touch lastUsedAt on assignment', () => {
			const added = registry.add(makeParams());
			expect(registry.get(added.id)?.lastUsedAt).toBe(0);

			registry.assignToSession('session-1', added.id);

			expect(registry.get(added.id)?.lastUsedAt).toBeGreaterThan(0);
		});
	});

	describe('getDefaultAccount', () => {
		it('should return null when no accounts exist', () => {
			expect(registry.getDefaultAccount()).toBeNull();
		});

		it('should return the default active account', () => {
			const added = registry.add(makeParams());

			expect(registry.getDefaultAccount()?.id).toBe(added.id);
		});

		it('should fall back to first active account if default is disabled', () => {
			const first = registry.add(makeParams({ email: 'a@example.com' }));
			registry.add(makeParams({ email: 'b@example.com' }));

			registry.setStatus(first.id, 'disabled');

			const defaultAcct = registry.getDefaultAccount();
			expect(defaultAcct?.email).toBe('b@example.com');
		});
	});

	describe('selectNextAccount', () => {
		it('should return null when no accounts available', () => {
			expect(registry.selectNextAccount()).toBeNull();
		});

		it('should select least-used account by default', () => {
			const a = registry.add(makeParams({ email: 'a@example.com' }));
			const b = registry.add(makeParams({ email: 'b@example.com' }));

			// Touch a so b is least-used
			registry.touchLastUsed(a.id);

			const next = registry.selectNextAccount();
			expect(next?.id).toBe(b.id);
		});

		it('should exclude specified account IDs', () => {
			const a = registry.add(makeParams({ email: 'a@example.com' }));
			const b = registry.add(makeParams({ email: 'b@example.com' }));

			const next = registry.selectNextAccount([a.id]);
			expect(next?.id).toBe(b.id);
		});

		it('should return null when all accounts are excluded', () => {
			const a = registry.add(makeParams({ email: 'a@example.com' }));

			expect(registry.selectNextAccount([a.id])).toBeNull();
		});

		it('should skip disabled accounts', () => {
			const a = registry.add(makeParams({ email: 'a@example.com' }));
			const b = registry.add(makeParams({ email: 'b@example.com' }));

			registry.setStatus(a.id, 'disabled');

			const next = registry.selectNextAccount();
			expect(next?.id).toBe(b.id);
		});

		it('should use round-robin when configured', () => {
			registry.updateSwitchConfig({ selectionStrategy: 'round-robin' });

			const a = registry.add(makeParams({ email: 'a@example.com' }));
			const b = registry.add(makeParams({ email: 'b@example.com' }));

			const first = registry.selectNextAccount();
			const second = registry.selectNextAccount();

			// Should cycle through accounts
			expect([first?.id, second?.id]).toContain(a.id);
			expect([first?.id, second?.id]).toContain(b.id);
		});

		describe('capacity-aware selection', () => {
			function createMockStatsDB(usageMap: Record<string, number>): AccountUsageStatsProvider {
				return {
					isReady: () => true,
					getAccountUsageInWindow: (id: string) => {
						const total = usageMap[id] ?? 0;
						return {
							inputTokens: total,
							outputTokens: 0,
							cacheReadTokens: 0,
							cacheCreationTokens: 0,
						};
					},
				};
			}

			it('should select account with most remaining capacity', () => {
				const a = registry.add(makeParams({ email: 'a@example.com' }));
				registry.update(a.id, { tokenLimitPerWindow: 10000 });
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				registry.update(b.id, { tokenLimitPerWindow: 10000 });

				// A used 8000, B used 2000 → B has more remaining
				const statsDB = createMockStatsDB({ [a.id]: 8000, [b.id]: 2000 });
				const next = registry.selectNextAccount([], statsDB);

				expect(next?.id).toBe(b.id);
			});

			it('should fall back to LRU when statsDB is not ready', () => {
				const a = registry.add(makeParams({ email: 'a@example.com' }));
				registry.update(a.id, { tokenLimitPerWindow: 10000 });
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				registry.update(b.id, { tokenLimitPerWindow: 10000 });

				registry.touchLastUsed(a.id);

				const statsDB: AccountUsageStatsProvider = {
					isReady: () => false,
					getAccountUsageInWindow: () => ({
						inputTokens: 0, outputTokens: 0,
						cacheReadTokens: 0, cacheCreationTokens: 0,
					}),
				};

				const next = registry.selectNextAccount([], statsDB);
				expect(next?.id).toBe(b.id); // b has lower lastUsedAt
			});

			it('should deprioritize recently throttled accounts', () => {
				const a = registry.add(makeParams({ email: 'a@example.com' }));
				registry.update(a.id, { tokenLimitPerWindow: 10000 });
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				registry.update(b.id, { tokenLimitPerWindow: 10000 });

				// A has more remaining capacity but was recently throttled
				registry.update(a.id, { lastThrottledAt: Date.now() - 60_000 }); // 1 min ago
				const statsDB = createMockStatsDB({ [a.id]: 2000, [b.id]: 4000 });

				const next = registry.selectNextAccount([], statsDB);
				// A remaining: (10000-2000)*0.5 = 4000 (penalized)
				// B remaining: 10000-4000 = 6000
				expect(next?.id).toBe(b.id);
			});

			it('should prefer accounts with configured limits over unlimited', () => {
				const a = registry.add(makeParams({ email: 'a@example.com' }));
				registry.update(a.id, { tokenLimitPerWindow: 10000 });
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				// b has no limit (tokenLimitPerWindow = 0)

				const statsDB = createMockStatsDB({ [a.id]: 2000, [b.id]: 0 });
				const next = registry.selectNextAccount([], statsDB);

				// A has known remaining capacity (8000), B is Infinity but deprioritized
				expect(next?.id).toBe(a.id);
			});

			it('should fall back to LRU when no accounts have limits', () => {
				const a = registry.add(makeParams({ email: 'a@example.com' }));
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				// Neither has tokenLimitPerWindow set

				registry.touchLastUsed(a.id);

				const statsDB = createMockStatsDB({ [a.id]: 5000, [b.id]: 1000 });
				const next = registry.selectNextAccount([], statsDB);

				// Both have Infinity remaining → falls back to LRU → b (lastUsedAt=0) wins
				expect(next?.id).toBe(b.id);
			});

			it('should select only remaining account when one is at capacity', () => {
				const a = registry.add(makeParams({ email: 'a@example.com' }));
				registry.update(a.id, { tokenLimitPerWindow: 10000 });
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				registry.update(b.id, { tokenLimitPerWindow: 10000 });

				// A is at 100% capacity, B has headroom
				const statsDB = createMockStatsDB({ [a.id]: 15000, [b.id]: 3000 });
				const next = registry.selectNextAccount([], statsDB);

				expect(next?.id).toBe(b.id);
			});

			it('should not use capacity-aware selection for round-robin strategy', () => {
				registry.updateSwitchConfig({ selectionStrategy: 'round-robin' });

				const a = registry.add(makeParams({ email: 'a@example.com' }));
				registry.update(a.id, { tokenLimitPerWindow: 10000 });
				const b = registry.add(makeParams({ email: 'b@example.com' }));
				registry.update(b.id, { tokenLimitPerWindow: 10000 });

				// Even though A has way more usage, round-robin should still cycle deterministically
				const statsDB = createMockStatsDB({ [a.id]: 9000, [b.id]: 1000 });
				const first = registry.selectNextAccount([], statsDB);
				const second = registry.selectNextAccount([], statsDB);

				// Both should appear (round-robin cycles)
				expect([first?.id, second?.id]).toContain(a.id);
				expect([first?.id, second?.id]).toContain(b.id);
			});
		});
	});

	describe('reconcileAssignments', () => {
		it('should remove assignments for sessions not in the active set', () => {
			const account = registry.add(makeParams());
			registry.assignToSession('session-1', account.id);
			registry.assignToSession('session-2', account.id);
			registry.assignToSession('session-3', account.id);

			// Only session-1 and session-3 are still active
			const removed = registry.reconcileAssignments(new Set(['session-1', 'session-3']));

			expect(removed).toBe(1);
			expect(registry.getAssignment('session-1')).not.toBeNull();
			expect(registry.getAssignment('session-2')).toBeNull();
			expect(registry.getAssignment('session-3')).not.toBeNull();
		});

		it('should return 0 when all assignments are valid', () => {
			const account = registry.add(makeParams());
			registry.assignToSession('session-1', account.id);

			const removed = registry.reconcileAssignments(new Set(['session-1']));

			expect(removed).toBe(0);
			expect(registry.getAssignment('session-1')).not.toBeNull();
		});

		it('should handle empty assignment map', () => {
			const removed = registry.reconcileAssignments(new Set(['session-1']));

			expect(removed).toBe(0);
		});

		it('should remove all assignments when no sessions are active', () => {
			const account = registry.add(makeParams());
			registry.assignToSession('session-1', account.id);
			registry.assignToSession('session-2', account.id);

			const removed = registry.reconcileAssignments(new Set());

			expect(removed).toBe(2);
			expect(registry.getAllAssignments()).toHaveLength(0);
		});
	});

	describe('switchConfig', () => {
		it('should return defaults initially', () => {
			const config = registry.getSwitchConfig();

			expect(config).toEqual(ACCOUNT_SWITCH_DEFAULTS);
		});

		it('should update config partially', () => {
			const updated = registry.updateSwitchConfig({
				enabled: true,
				warningThresholdPercent: 70,
			});

			expect(updated.enabled).toBe(true);
			expect(updated.warningThresholdPercent).toBe(70);
			expect(updated.promptBeforeSwitch).toBe(true); // unchanged default
		});
	});
});
