import { describe, expect, it } from 'vitest';

import {
	parseGhActiveAccount,
	isGitHubAuthError,
	isGitHubMissingScopeError,
	isGitHubOAuthRestrictionError,
} from '../../../main/utils/ghErrors';

const OAUTH_RESTRICTION =
	'GraphQL: Although you appear to have the correct authorization credentials, the `RunMaestro` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited. For more information on these policies, including how to enable this app, visit https://docs.github.com/articles/restricting-access-to-your-organization-s-data/ (createIssue)';

describe('gh error classifiers', () => {
	it('reads an expired or revoked token as an auth error', () => {
		expect(isGitHubAuthError('HTTP 401: Bad credentials (https://api.github.com/user)')).toBe(true);
		expect(
			isGitHubAuthError({
				message: 'failed',
				stderr: 'To get started with GitHub CLI, please run:  gh auth login',
			})
		).toBe(true);
		expect(isGitHubAuthError('HTTP 404: Not Found')).toBe(false);
	});

	it('reads an org OAuth app restriction apart from a broken login', () => {
		expect(isGitHubOAuthRestrictionError(OAUTH_RESTRICTION)).toBe(true);
		expect(isGitHubAuthError(OAUTH_RESTRICTION)).toBe(false);
		expect(isGitHubOAuthRestrictionError('HTTP 401: Bad credentials')).toBe(false);
	});

	it('reads a token without a needed scope', () => {
		expect(
			isGitHubMissingScopeError(
				'GraphQL: Your token has not been granted the required scopes to execute this query.'
			)
		).toBe(true);
		expect(
			isGitHubMissingScopeError(
				'error: your authentication token is missing required scopes [repo]'
			)
		).toBe(true);
		expect(isGitHubMissingScopeError('HTTP 401: Bad credentials')).toBe(false);
	});
});

describe('parseGhActiveAccount', () => {
	it('names the active account in gh 2.40+ output', () => {
		const output = [
			'github.com',
			'  ✓ Logged in to github.com account work-user (keyring)',
			'  - Active account: false',
			'  ✓ Logged in to github.com account home-user (keyring)',
			'  - Active account: true',
		].join('\n');
		expect(parseGhActiveAccount(output)).toEqual({ host: 'github.com', login: 'home-user' });
	});

	it('names an account whose login has expired', () => {
		const output =
			'github.com\n  X Failed to log in to github.com account octocat (keyring)\n  - Active account: true';
		expect(parseGhActiveAccount(output)).toEqual({ host: 'github.com', login: 'octocat' });
	});

	// An env token has no login name. Falling back to the keyring account below
	// it would name an account gh is not using.
	it('names nobody when the active credential is an env token', () => {
		const output = [
			'github.com',
			'  X Failed to log in to github.com using token (GH_TOKEN)',
			'  - Active account: true',
			'  ✓ Logged in to github.com account octocat (keyring)',
			'  - Active account: false',
		].join('\n');
		expect(parseGhActiveAccount(output)).toBeUndefined();
	});

	it('reads older gh, which says "as" and marks no active account', () => {
		expect(
			parseGhActiveAccount('github.com\n  ✓ Logged in to github.com as octocat (oauth_token)')
		).toEqual({ host: 'github.com', login: 'octocat' });
	});

	it('returns undefined for output it does not recognize', () => {
		expect(parseGhActiveAccount('')).toBeUndefined();
		expect(parseGhActiveAccount('You are not logged into any GitHub hosts.')).toBeUndefined();
	});
});
