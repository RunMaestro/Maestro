/**
 * A headless `maestro-cli host` loads the token-usage reader in plain Node, where Electron does
 * not exist. The CLI bundle aliases `electron` to a shim, which would hide a module-scope reach;
 * here any import of Electron fails the load outright.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => {
	throw new Error('Electron was imported');
});

describe('token usage reader modules', () => {
	it('load with no Electron at all', async () => {
		await expect(
			import('../../../../main/stats/token-usage/project-breakdowns')
		).resolves.toBeDefined();
		await expect(
			import('../../../../main/agents/provider-account-dirs-core')
		).resolves.toBeDefined();
	});
});
