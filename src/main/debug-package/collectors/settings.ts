/**
 * Settings Collector
 *
 * Collects application settings with sensitive and identifying data removed.
 * - API keys and tokens are replaced with [REDACTED]
 * - Usernames, hostnames, and SSH remote identities are replaced with [REDACTED]
 * - Paths are replaced with opaque descriptors (no folder or project names)
 * - Every remaining string is swept for embedded paths, URLs, and identity
 */

import Store from 'electron-store';
import { redactAndTruncate, redactPath } from './sanitize';

// Keys that contain sensitive data (case-insensitive substring matching)
const SENSITIVE_KEYS = [
	'apikey',
	'api_key',
	'authtoken',
	'auth_token',
	'clienttoken',
	'client_token',
	'password',
	'passphrase',
	'secret',
	'credential',
	'accesstoken',
	'access_token',
	'refreshtoken',
	'refresh_token',
	'privatekey',
	'private_key',
	// Identity: SSH remotes and git remotes carry the user's name, machine, and
	// repository, all of which are exactly what must not reach a public issue.
	'username',
	'hostname',
	'host',
	'email',
	'remoteurl',
	'remote_url',
	'originurl',
	'origin_url',
	'repourl',
	'repo_url',
];

// Keys whose exact name (not substring) marks identifying data.
// User-chosen labels ('name', 'title', 'label') are included on purpose: in
// settings they name SSH remotes, custom agents, and presets, which is where
// project and client names show up. Agent and group diagnostics come from
// their own collectors, so nothing useful is lost.
const IDENTITY_KEYS = [
	'user',
	'login',
	'account',
	'owner',
	'name',
	'displayname',
	'fullname',
	'title',
	'label',
	'projectname',
	'reponame',
	'repository',
	'foldername',
	'workspacename',
];

// Keys that contain paths, which are replaced with opaque descriptors
const PATH_KEYS = [
	'customsyncpath',
	'custompath',
	'ghpath',
	'customshellpath',
	'path',
	'cwd',
	'projectroot',
	'fullpath',
	'folderpath',
];

export interface SanitizedSettings {
	raw: Record<string, unknown>; // Sanitized settings object
	sanitizedFields: string[]; // List of fields that were sanitized
}

/**
 * Check if a key contains sensitive or identifying data based on its name
 */
function isSensitiveKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return (
		SENSITIVE_KEYS.some((sensitiveKey) => lowerKey.includes(sensitiveKey)) ||
		IDENTITY_KEYS.includes(lowerKey)
	);
}

/**
 * Check if a key is a path that should be redacted
 */
function isPathKey(key: string): boolean {
	const lowerKey = key.toLowerCase();
	return PATH_KEYS.some((pathKey) => lowerKey.includes(pathKey));
}

/**
 * Recursively sanitize an object, tracking what was sanitized.
 * Strings are swept regardless of their key: a path can hang off any name,
 * and key-based rules alone have historically missed arrays of paths.
 */
function sanitizeObject(obj: unknown, sanitizedFields: string[], prefix: string = ''): unknown {
	if (obj === null || obj === undefined) {
		return obj;
	}

	if (typeof obj === 'string') {
		return redactAndTruncate(obj);
	}

	if (Array.isArray(obj)) {
		return obj.map((item, index) => sanitizeObject(item, sanitizedFields, `${prefix}[${index}]`));
	}

	if (typeof obj === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			const fullKey = prefix ? `${prefix}.${key}` : key;

			if (isSensitiveKey(key)) {
				result[key] = '[REDACTED]';
				sanitizedFields.push(fullKey);
			} else if (typeof value === 'string' && isPathKey(key)) {
				result[key] = redactPath(value);
				if (result[key] !== value) {
					sanitizedFields.push(fullKey);
				}
			} else {
				result[key] = sanitizeObject(value, sanitizedFields, fullKey);
				if (typeof value === 'string' && result[key] !== value) {
					sanitizedFields.push(fullKey);
				}
			}
		}
		return result;
	}

	return obj;
}

/**
 * Collect application settings with sensitive data sanitized.
 */
export async function collectSettings(
	settingsStore: Store<any>,
	bootstrapStore?: Store<any>
): Promise<SanitizedSettings> {
	const sanitizedFields: string[] = [];

	// Get all settings from the store
	const allSettings = settingsStore.store || {};

	// Sanitize the settings
	const sanitized = sanitizeObject(allSettings, sanitizedFields) as Record<string, unknown>;

	// Add sync path info (just whether it's set, not the actual path)
	if (bootstrapStore) {
		const customSyncPath = bootstrapStore.get('customSyncPath');
		sanitized['_syncInfo'] = {
			hasCustomSyncPath: !!customSyncPath,
			customSyncPath: customSyncPath ? redactPath(customSyncPath) : undefined,
		};
	}

	return {
		raw: sanitized,
		sanitizedFields,
	};
}
