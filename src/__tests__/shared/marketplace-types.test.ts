/**
 * Tests for the marketplace error classes in src/shared/marketplace-types.ts.
 */

import { describe, it, expect } from 'vitest';
import {
	MarketplaceImportError,
	MarketplaceLaunchValuesError,
} from '../../shared/marketplace-types';

describe('MarketplaceLaunchValuesError', () => {
	const fieldErrors = {
		PR_URL: 'This field is required',
		MAX_ROUNDS: 'Must be at least 1',
	};

	it('keeps the message for each failing input, keyed by input name', () => {
		expect(new MarketplaceLaunchValuesError(fieldErrors).fieldErrors).toEqual(fieldErrors);
	});

	it('names every failing field in its message, in the order given', () => {
		expect(new MarketplaceLaunchValuesError(fieldErrors).message).toBe(
			'Launch values are not valid: PR_URL: This field is required; MAX_ROUNDS: Must be at least 1'
		);
	});

	it('is an import error, so callers that handle MarketplaceImportError keep working', () => {
		const error = new MarketplaceLaunchValuesError(fieldErrors);
		expect(error).toBeInstanceOf(MarketplaceImportError);
		expect(error).toBeInstanceOf(Error);
		expect(error.type).toBe('import');
		expect(error.name).toBe('MarketplaceLaunchValuesError');
	});
});
