/**
 * Smoke test to verify Jest setup is working correctly.
 */

describe('Jest setup', () => {
	it('can run basic arithmetic', () => {
		expect(1 + 1).toBe(2);
	});

	it('can run async tests', async () => {
		const result = await Promise.resolve(42);
		expect(result).toBe(42);
	});
});
