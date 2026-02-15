import type Store from 'electron-store';
import type { AccountStoreData } from '../stores/account-store-types';
import type {
	AccountProfile,
	AccountAssignment,
	AccountSwitchConfig,
	AccountId,
	AccountStatus,
} from '../../shared/account-types';
import { DEFAULT_TOKEN_WINDOW_MS, ACCOUNT_SWITCH_DEFAULTS } from '../../shared/account-types';
import { generateUUID } from '../../shared/uuid';
import { logger } from '../utils/logger';
import { getWindowBounds } from './account-utils';

/** Minimal interface for usage stats queries — avoids hard dependency on StatsDB */
export interface AccountUsageStatsProvider {
	getAccountUsageInWindow(id: string, start: number, end: number): {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheCreationTokens: number;
	};
	isReady(): boolean;
}

const LOG_CONTEXT = 'AccountRegistry';

export class AccountRegistry {
	constructor(private store: Store<AccountStoreData>) {}

	// --- Account CRUD ---

	/** Get all registered accounts */
	getAll(): AccountProfile[] {
		const accounts = this.store.get('accounts', {});
		return Object.values(accounts);
	}

	/** Get a single account by ID */
	get(id: AccountId): AccountProfile | null {
		const accounts = this.store.get('accounts', {});
		return accounts[id] ?? null;
	}

	/** Find account by email */
	findByEmail(email: string): AccountProfile | null {
		return this.getAll().find(a => a.email === email) ?? null;
	}

	/** Find account by config directory path */
	findByConfigDir(configDir: string): AccountProfile | null {
		return this.getAll().find(a => a.configDir === configDir) ?? null;
	}

	/** Register a new account. Returns the created profile. */
	add(params: {
		name: string;
		email: string;
		configDir: string;
		agentType?: 'claude-code';
		authMethod?: 'oauth' | 'api-key';
	}): AccountProfile {
		// Check for duplicate email
		const existing = this.findByEmail(params.email);
		if (existing) {
			throw new Error(`Account with email "${params.email}" already exists (ID: ${existing.id})`);
		}

		const now = Date.now();
		const isFirst = this.getAll().length === 0;
		const profile: AccountProfile = {
			id: generateUUID(),
			name: params.name,
			email: params.email,
			configDir: params.configDir,
			agentType: params.agentType ?? 'claude-code',
			status: 'active',
			authMethod: params.authMethod ?? 'oauth',
			addedAt: now,
			lastUsedAt: 0,
			lastThrottledAt: 0,
			tokenLimitPerWindow: 0,
			tokenWindowMs: DEFAULT_TOKEN_WINDOW_MS,
			isDefault: isFirst, // First account is default
			autoSwitchEnabled: true,
		};

		const accounts = this.store.get('accounts', {});
		accounts[profile.id] = profile;
		this.store.set('accounts', accounts);

		// Add to rotation order
		const order = this.store.get('rotationOrder', []);
		order.push(profile.id);
		this.store.set('rotationOrder', order);

		return profile;
	}

	/** Update an existing account profile. Returns updated profile or null if not found. */
	update(id: AccountId, updates: Partial<Omit<AccountProfile, 'id'>>): AccountProfile | null {
		const accounts = this.store.get('accounts', {});
		const existing = accounts[id];
		if (!existing) return null;

		// If setting this as default, clear default from others
		if (updates.isDefault) {
			for (const acct of Object.values(accounts)) {
				acct.isDefault = false;
			}
		}

		accounts[id] = { ...existing, ...updates };
		this.store.set('accounts', accounts);
		return accounts[id];
	}

	/** Remove an account. Returns true if found and removed. */
	remove(id: AccountId): boolean {
		const accounts = this.store.get('accounts', {});
		if (!accounts[id]) return false;

		delete accounts[id];
		this.store.set('accounts', accounts);

		// Remove from rotation order
		const order = this.store.get('rotationOrder', []);
		this.store.set('rotationOrder', order.filter(aid => aid !== id));

		// Remove any assignments pointing to this account
		const assignments = this.store.get('assignments', {});
		for (const [sid, assignment] of Object.entries(assignments)) {
			if (assignment.accountId === id) {
				delete assignments[sid];
			}
		}
		this.store.set('assignments', assignments);

		return true;
	}

	/** Update account status (active, throttled, expired, disabled) */
	setStatus(id: AccountId, status: AccountStatus): void {
		const accounts = this.store.get('accounts', {});
		if (!accounts[id]) return;
		accounts[id].status = status;
		if (status === 'throttled') {
			accounts[id].lastThrottledAt = Date.now();
		}
		this.store.set('accounts', accounts);
	}

	/** Mark account as recently used */
	touchLastUsed(id: AccountId): void {
		const accounts = this.store.get('accounts', {});
		if (!accounts[id]) return;
		accounts[id].lastUsedAt = Date.now();
		this.store.set('accounts', accounts);
	}

	// --- Assignments ---

	/** Assign an account to a session */
	assignToSession(sessionId: string, accountId: AccountId): AccountAssignment {
		const assignment: AccountAssignment = {
			sessionId,
			accountId,
			assignedAt: Date.now(),
		};
		const assignments = this.store.get('assignments', {});
		assignments[sessionId] = assignment;
		this.store.set('assignments', assignments);
		this.touchLastUsed(accountId);
		return assignment;
	}

	/** Get the account assigned to a session */
	getAssignment(sessionId: string): AccountAssignment | null {
		const assignments = this.store.get('assignments', {});
		return assignments[sessionId] ?? null;
	}

	/** Remove a session assignment (e.g., when session is closed) */
	removeAssignment(sessionId: string): void {
		const assignments = this.store.get('assignments', {});
		delete assignments[sessionId];
		this.store.set('assignments', assignments);
	}

	/** Get all current assignments */
	getAllAssignments(): AccountAssignment[] {
		return Object.values(this.store.get('assignments', {}));
	}

	/** Get the default account (first one marked isDefault, or first active) */
	getDefaultAccount(): AccountProfile | null {
		const all = this.getAll();
		return all.find(a => a.isDefault && a.status === 'active')
			?? all.find(a => a.status === 'active')
			?? null;
	}

	/**
	 * Select the next account using the configured strategy.
	 * When statsDB is provided, uses actual token consumption for routing.
	 * Falls back to lastUsedAt-based selection when statsDB is unavailable.
	 */
	selectNextAccount(excludeIds: AccountId[] = [], statsDB?: AccountUsageStatsProvider): AccountProfile | null {
		const config = this.getSwitchConfig();
		const available = this.getAll().filter(
			a => a.status === 'active' && a.autoSwitchEnabled && !excludeIds.includes(a.id)
		);
		if (available.length === 0) return null;

		if (config.selectionStrategy === 'round-robin') {
			const order = this.store.get('rotationOrder', []).filter(
				id => available.some(a => a.id === id)
			);
			if (order.length === 0) return available[0];
			const idx = (this.store.get('rotationIndex', 0) + 1) % order.length;
			this.store.set('rotationIndex', idx);
			return available.find(a => a.id === order[idx]) ?? available[0];
		}

		// least-used: prefer capacity-aware selection when statsDB is available
		if (statsDB && statsDB.isReady()) {
			return this.selectByRemainingCapacity(available, statsDB);
		}

		// Fallback: sort by lastUsedAt ascending (least recently used first)
		available.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
		return available[0];
	}

	/**
	 * Select the account with the most remaining capacity in its current window.
	 * Accounts without configured limits are treated as having infinite remaining capacity,
	 * but deprioritized behind accounts with known remaining capacity.
	 */
	private selectByRemainingCapacity(
		accounts: AccountProfile[],
		statsDB: AccountUsageStatsProvider,
	): AccountProfile {
		const now = Date.now();

		const scored = accounts.map(account => {
			const windowMs = account.tokenWindowMs || DEFAULT_TOKEN_WINDOW_MS;
			const { start: windowStart, end: windowEnd } = getWindowBounds(now, windowMs);

			const usage = statsDB.getAccountUsageInWindow(account.id, windowStart, windowEnd);
			const totalTokens = usage.inputTokens + usage.outputTokens
				+ usage.cacheReadTokens + usage.cacheCreationTokens;

			let remainingCapacity: number;

			if (account.tokenLimitPerWindow > 0) {
				remainingCapacity = Math.max(0, account.tokenLimitPerWindow - totalTokens);
			} else {
				remainingCapacity = Infinity;
			}

			// Deprioritize accounts that were recently throttled (within last 2 windows)
			const recentThrottlePenalty = account.lastThrottledAt > 0
				&& (now - account.lastThrottledAt) < windowMs * 2
				? 0.5
				: 1.0;

			return {
				account,
				remainingCapacity: remainingCapacity === Infinity
					? Infinity
					: remainingCapacity * recentThrottlePenalty,
			};
		});

		// Sort: most remaining capacity first
		const hasLimits = scored.some(s => s.remainingCapacity !== Infinity);

		if (hasLimits) {
			scored.sort((a, b) => {
				// Finite capacity always before infinite
				if (a.remainingCapacity === Infinity && b.remainingCapacity !== Infinity) return 1;
				if (a.remainingCapacity !== Infinity && b.remainingCapacity === Infinity) return -1;
				// Both finite: higher remaining first
				return (b.remainingCapacity as number) - (a.remainingCapacity as number);
			});
		} else {
			// No limits configured on any account — fall back to LRU
			scored.sort((a, b) => a.account.lastUsedAt - b.account.lastUsedAt);
		}

		return scored[0].account;
	}

	// --- Reconciliation ---

	/**
	 * Reconcile assignments with a list of active session IDs.
	 * Removes assignments for sessions that no longer exist.
	 * Called on app startup after session restore.
	 */
	reconcileAssignments(activeSessionIds: Set<string>): number {
		const assignments = this.getAllAssignments();
		let removed = 0;
		for (const assignment of assignments) {
			if (!activeSessionIds.has(assignment.sessionId)) {
				this.removeAssignment(assignment.sessionId);
				removed++;
			}
		}
		if (removed > 0) {
			logger.info(`Reconciled ${removed} stale account assignments`, LOG_CONTEXT);
		}
		return removed;
	}

	// --- Switch Config ---

	getSwitchConfig(): AccountSwitchConfig {
		return this.store.get('switchConfig', ACCOUNT_SWITCH_DEFAULTS);
	}

	updateSwitchConfig(updates: Partial<AccountSwitchConfig>): AccountSwitchConfig {
		const current = this.getSwitchConfig();
		const updated = { ...current, ...updates };
		this.store.set('switchConfig', updated);
		return updated;
	}
}
