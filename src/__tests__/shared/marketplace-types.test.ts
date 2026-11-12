/**
 * Tests for the marketplace error classes in src/shared/marketplace-types.ts.
 */

import { describe, it, expect } from 'vitest';
import {
	launchFieldErrorsFromMessage,
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

describe('launchFieldErrorsFromMessage', () => {
	const prefix = 'Launch values are not valid: ';

	it('reads back the field errors the error class wrote, in order', () => {
		const fieldErrors = {
			PR_URL: 'This field is required',
			MAX_ROUNDS: 'Must be at least 1',
			BOT_REVIEWERS: 'Pick only from the listed options',
		};
		const message = new MarketplaceLaunchValuesError(fieldErrors).message;

		const read = launchFieldErrorsFromMessage(message);

		expect(read).toStrictEqual(fieldErrors);
		expect(Object.keys(read ?? {})).toEqual(['PR_URL', 'MAX_ROUNDS', 'BOT_REVIEWERS']);
	});

	it('reads a single field', () => {
		expect(launchFieldErrorsFromMessage(`${prefix}PR_URL: This field is required`)).toStrictEqual({
			PR_URL: 'This field is required',
		});
	});

	it('keeps a message that contains a colon, a semicolon or a URL whole', () => {
		const fieldErrors = {
			PR_URL: 'Enter a full http:// or https:// URL',
			NOTE: 'Use one value; not two: pick one',
		};

		expect(
			launchFieldErrorsFromMessage(new MarketplaceLaunchValuesError(fieldErrors).message)
		).toStrictEqual(fieldErrors);
	});

	it('splits only where a field name starts, so a lowercase word after a semicolon stays in the text', () => {
		expect(
			launchFieldErrorsFromMessage(`${prefix}A_B: first; then second; C_D: third`)
		).toStrictEqual({ A_B: 'first; then second', C_D: 'third' });
	});

	it('reads digits and underscores in a field name', () => {
		expect(launchFieldErrorsFromMessage(`${prefix}MAX_FILE_LOC2: Enter a number`)).toStrictEqual({
			MAX_FILE_LOC2: 'Enter a number',
		});
	});

	it('is null for text that is not such a message', () => {
		expect(launchFieldErrorsFromMessage('')).toBeNull();
		expect(launchFieldErrorsFromMessage('Failed to fetch document: 1_ANALYZE.md')).toBeNull();
		expect(
			launchFieldErrorsFromMessage(
				'MarketplaceLaunchValuesError: Launch values are not valid: A: b'
			)
		).toBeNull();
		expect(launchFieldErrorsFromMessage(`Please note. ${prefix}PR_URL: Required`)).toBeNull();
	});

	it('is null when the list is empty or does not open with a field name', () => {
		expect(launchFieldErrorsFromMessage(prefix)).toBeNull();
		expect(launchFieldErrorsFromMessage(prefix.trim())).toBeNull();
		expect(
			launchFieldErrorsFromMessage(`${prefix}pr_url: lower case is not an input name`)
		).toBeNull();
		expect(launchFieldErrorsFromMessage(`${prefix}see below; PR_URL: Required`)).toBeNull();
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
