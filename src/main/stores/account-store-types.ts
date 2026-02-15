import type { AccountProfile, AccountAssignment, AccountSwitchConfig } from '../../shared/account-types';

export interface AccountStoreData {
	/** All registered account profiles, keyed by account ID */
	accounts: Record<string, AccountProfile>;
	/** Current session-to-account assignments, keyed by session ID */
	assignments: Record<string, AccountAssignment>;
	/** Global account switching configuration */
	switchConfig: AccountSwitchConfig;
	/** Ordered list of account IDs for round-robin assignment */
	rotationOrder: string[];
	/** Index of the last account used in round-robin rotation */
	rotationIndex: number;
}
