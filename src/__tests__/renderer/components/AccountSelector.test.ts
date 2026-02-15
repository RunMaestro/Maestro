/**
 * @file AccountSelector.test.ts
 * @description Tests for AccountSelector component exports
 */

import { describe, it, expect } from 'vitest';

describe('AccountSelector', () => {
	it('should export the component', async () => {
		const mod = await import('../../../renderer/components/AccountSelector');
		expect(mod.AccountSelector).toBeDefined();
		expect(typeof mod.AccountSelector).toBe('function');
	});
});
