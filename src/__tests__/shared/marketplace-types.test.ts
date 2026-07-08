import {
	MarketplaceCacheError,
	MarketplaceFetchError,
	MarketplaceImportError,
} from '../../shared/marketplace-types';

describe('marketplace-types runtime errors', () => {
	it('creates marketplace fetch errors with network type and cause', () => {
		const cause = new Error('network down');
		const error = new MarketplaceFetchError('Failed to fetch manifest', cause);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('MarketplaceFetchError');
		expect(error.message).toBe('Failed to fetch manifest');
		expect(error.type).toBe('network');
		expect(error.cause).toBe(cause);
	});

	it('creates marketplace cache errors with cache type and cause', () => {
		const cause = { code: 'EACCES' };
		const error = new MarketplaceCacheError('Failed to read cache', cause);

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('MarketplaceCacheError');
		expect(error.message).toBe('Failed to read cache');
		expect(error.type).toBe('cache');
		expect(error.cause).toBe(cause);
	});

	it('creates marketplace import errors with import type and optional cause', () => {
		const error = new MarketplaceImportError('Failed to import playbook');

		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe('MarketplaceImportError');
		expect(error.message).toBe('Failed to import playbook');
		expect(error.type).toBe('import');
		expect(error.cause).toBeUndefined();
	});
});
