import { afterEach, describe, expect, it } from 'vitest';
import { activate, deactivate } from '../../runtime';

afterEach(async () => deactivate());

describe('OMP plugin activation', () => {
	it('remains loadable with an SDK that exposes neither retired UI surface', async () => {
		await expect(activate({} as Parameters<typeof activate>[0])).resolves.toBeUndefined();
	});
});
