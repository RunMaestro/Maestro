// Accounts command - list configured Claude accounts

import { readAccountsFromStore } from '../services/account-reader';

export async function listAccounts(): Promise<void> {
	const accounts = await readAccountsFromStore();

	if (accounts.length === 0) {
		console.log('No accounts configured. Use Maestro Settings > Accounts to add accounts.');
		return;
	}

	console.log('\nConfigured Accounts:');
	console.log('\u2500'.repeat(60));

	for (const account of accounts) {
		const defaultBadge = account.isDefault ? ' [DEFAULT]' : '';
		const statusIcon =
			account.status === 'active'
				? '\u2713'
				: account.status === 'throttled'
					? '\u26A0'
					: '\u2717';
		console.log(`  ${statusIcon} ${account.name}${defaultBadge}`);
		console.log(`    Email:  ${account.email || 'unknown'}`);
		console.log(`    Dir:    ${account.configDir}`);
		console.log(`    Status: ${account.status}`);
		console.log('');
	}
}
