/**
 * Tests for the marketplace error classes in src/shared/marketplace-types.ts.
 */

import { describe, it, expect } from 'vitest';
import {
	MarketplaceImportError,
	MarketplaceLaunchBusyError,
	MarketplaceLaunchCleanupError,
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

describe('MarketplaceLaunchBusyError', () => {
	const running = { launchId: 'launch-7', playbookTitle: 'Market Research' };

	it('names the launch in the way', () => {
		expect(new MarketplaceLaunchBusyError(running).runningLaunchId).toBe('launch-7');
	});

	it('says which playbook the agent runs and what to do', () => {
		expect(new MarketplaceLaunchBusyError(running).message).toBe(
			'This agent is already running the "Market Research" launch (launch-7). Wait for it to finish, or stop it, then launch again.'
		);
	});

	it('is an import error, so callers that handle MarketplaceImportError keep working', () => {
		const error = new MarketplaceLaunchBusyError(running);
		expect(error).toBeInstanceOf(MarketplaceImportError);
		expect(error).toBeInstanceOf(Error);
		expect(error.type).toBe('import');
		expect(error.name).toBe('MarketplaceLaunchBusyError');
	});
});

describe('MarketplaceLaunchCleanupError', () => {
	it('names the refused folder and the reason', () => {
		const error = new MarketplaceLaunchCleanupError('../outside', 'it is not a single folder name');
		expect(error.folderRelativePath).toBe('../outside');
		expect(error.message).toBe(
			'Refusing to delete the launch folder "../outside": it is not a single folder name'
		);
	});

	it('is an import error, so callers that handle MarketplaceImportError keep working', () => {
		const error = new MarketplaceLaunchCleanupError('launch-1', 'it is a symbolic link');
		expect(error).toBeInstanceOf(MarketplaceImportError);
		expect(error).toBeInstanceOf(Error);
		expect(error.type).toBe('import');
		expect(error.name).toBe('MarketplaceLaunchCleanupError');
	});
});
