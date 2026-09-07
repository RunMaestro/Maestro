/**
 * Sanitization Utilities
 *
 * Shared redaction functions for debug package collectors.
 *
 * Support packages routinely end up attached to public GitHub issues, so they
 * must not carry anything that identifies the user or their work: no usernames,
 * no hostnames, no file paths, no project, folder, or repository names.
 *
 * Paths are therefore not "sanitized" (home replaced with `~`, which still
 * exposes every folder and project name below it) but replaced outright with an
 * opaque token that keeps only the shape a support engineer actually needs:
 *
 *   [path#3f9a1c04 root=home depth=4 ext=.json spaces]
 *
 * The fingerprint is stable within a single package, so "these two agents share
 * a cwd" stays visible, and it is salted per process so nothing can be
 * correlated across packages or brute-forced against a guessed project name.
 */

import crypto from 'crypto';
import os from 'os';
import { redactSecrets } from '../../acappella/providers/credentials';
import { escapeRegExp } from '../../../shared/stringUtils';

/** Per-process salt: stable inside one package, useless outside it. */
const FINGERPRINT_SALT = crypto.randomBytes(16);

/** Free text over this length is likely a prompt or conversation content. */
const MAX_TEXT_LENGTH = 500;

/**
 * Short, salted digest of a value. Same input yields the same token for the
 * lifetime of the process, which is what makes cross-referencing possible
 * without disclosing the value itself.
 */
function fingerprint(value: string): string {
	return crypto
		.createHash('sha256')
		.update(FINGERPRINT_SALT)
		.update(value.toLowerCase())
		.digest('hex')
		.slice(0, 8);
}

function normalizeSlashes(pathStr: string): string {
	return pathStr.replace(/\\/g, '/');
}

/**
 * Classify the root of a path without revealing any of its segments.
 * Home is checked before drive letters so a Windows home path reports
 * `root=home` rather than `root=C:`.
 */
function splitRoot(normalized: string, isUnc: boolean): { root: string; rest: string } {
	if (isUnc) {
		return { root: 'unc', rest: normalized.replace(/^\/+/, '') };
	}

	const home = normalizeSlashes(os.homedir() || '');
	if (home && (normalized === home || normalized.startsWith(`${home}/`))) {
		return { root: 'home', rest: normalized.slice(home.length) };
	}
	if (/^~($|\/)/.test(normalized)) {
		return { root: 'home', rest: normalized.slice(1) };
	}

	const drive = normalized.match(/^([A-Za-z]):\/?/);
	if (drive) {
		return { root: `${drive[1].toUpperCase()}:`, rest: normalized.slice(drive[0].length) };
	}
	if (normalized.startsWith('/')) {
		return { root: '/', rest: normalized };
	}
	return { root: 'rel', rest: normalized };
}

/**
 * Replace a file path with an opaque, non-identifying descriptor.
 * Non-string and empty values are returned untouched.
 */
export function redactPath(pathStr: string): string {
	if (typeof pathStr !== 'string' || pathStr.trim() === '') {
		return pathStr;
	}

	const isUnc = /^(\\\\|\/\/)/.test(pathStr);
	const normalized = normalizeSlashes(pathStr);
	const { root, rest } = splitRoot(normalized, isUnc);
	const segments = rest.split('/').filter(Boolean);

	const parts = [`path#${fingerprint(normalized)}`, `root=${root}`, `depth=${segments.length}`];

	// A trailing extension is worth keeping (it says "this was a .json, not a
	// directory") and cannot identify anyone on its own. Dotfiles are skipped:
	// the whole name would leak.
	const lastSegment = segments[segments.length - 1] || '';
	const ext = lastSegment.match(/^.+(\.[A-Za-z0-9]{1,8})$/);
	if (ext) {
		parts.push(`ext=${ext[1].toLowerCase()}`);
	}

	// Spaces and non-ASCII characters are the classic cause of spawn failures on
	// Windows, so flag them even though the path itself is gone.
	if (/\s/.test(pathStr)) {
		parts.push('spaces');
	}
	if (/[^\x20-\x7E]/.test(pathStr)) {
		parts.push('non-ascii');
	}

	return `[${parts.join(' ')}]`;
}

/**
 * Reduce a hostname to something non-identifying. Loopback is kept verbatim,
 * IP literals are dropped, and only the registrable domain survives so a
 * random tunnel subdomain (which is effectively a live access token) is gone
 * while "this was Cloudflare" remains readable.
 */
function redactHost(hostname: string): string {
	const lower = (hostname || '').toLowerCase();
	if (!lower) return '[host]';
	if (lower === 'localhost' || lower === '127.0.0.1' || lower === '::1' || lower === '[::1]') {
		return lower;
	}
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(lower) || lower.includes(':')) {
		return '[ip]';
	}
	const labels = lower.split('.');
	return labels.length <= 2 ? lower : labels.slice(-2).join('.');
}

/**
 * Replace a URL with its scheme and registrable domain only.
 * `file:` URLs are treated as paths.
 */
function redactUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `[url#${fingerprint(url)}]`;
	}

	if (parsed.protocol === 'file:') {
		try {
			return redactPath(decodeURIComponent(parsed.pathname));
		} catch {
			return redactPath(parsed.pathname);
		}
	}

	const port = parsed.port ? `:${parsed.port}` : '';
	const hasPath = (parsed.pathname && parsed.pathname !== '/') || !!parsed.search || !!parsed.hash;
	const suffix = hasPath ? '/[redacted]' : '';
	return `[url#${fingerprint(url)} ${parsed.protocol}//${redactHost(parsed.hostname)}${port}${suffix}]`;
}

/**
 * Windows path body. Spaces are common in Windows paths ("OneDrive - Acme
 * Corp\app"), so a space is consumed when another backslash follows within a
 * few words. Prose rarely contains backslashes, which is what keeps this from
 * swallowing the rest of the sentence.
 */
const PATH_TAIL_WIN = String.raw`(?:[^\s"'<>|]| (?=(?:[^\s"'<>|]+ ){0,3}[^\s"'<>|]*\\))*`;

/**
 * POSIX path body. Deliberately stricter than the Windows one: a space is only
 * consumed when the very next word contains a slash ("My Drive/project"), so a
 * sentence that mentions two paths stays readable.
 */
const PATH_TAIL_POSIX = String.raw`(?:[^\s"'<>|]| (?=[^\s"'<>|]*\/))*`;

/**
 * Matches the things in free text that can carry identity: URLs, `user@host`
 * accounts and scp-style git remotes, UNC paths, drive paths, `~` paths, and
 * absolute POSIX paths. POSIX paths require at least two segments so ordinary
 * prose ("and/or", "n/a") survives, and the account host must contain a letter
 * so version specifiers ("eslint@9.39.4") do not match.
 */
const TEXT_TARGET_RE = new RegExp(
	[
		String.raw`[A-Za-z][A-Za-z0-9+.\-]*:\/\/[^\s"'<>]+`,
		String.raw`[A-Za-z0-9._%+\-]+@(?:[A-Za-z0-9\-]+\.)*[A-Za-z0-9\-]*[A-Za-z][A-Za-z0-9\-]*(?::[^\s"'<>|]+)?`,
		String.raw`\\\\${PATH_TAIL_WIN}`,
		String.raw`[A-Za-z]:[\\/]${PATH_TAIL_WIN}`,
		String.raw`~[\\/]${PATH_TAIL_POSIX}`,
		String.raw`(?:\/(?:[\w.@+\-]| (?=[^\s"'<>|]*\/))+){2,}\/?`,
	].join('|'),
	'g'
);

/** A `user@host` or `git@host:org/repo` match rather than a path. */
const ACCOUNT_RE = /^[A-Za-z0-9._%+-]+@/;

/** Words that appear inside the descriptors this module emits. */
const TOKEN_VOCABULARY = new Set([
	'path',
	'url',
	'root',
	'home',
	'depth',
	'ext',
	'spaces',
	'non-ascii',
	'rel',
	'unc',
	'user',
	'host',
	'redacted',
	'truncated',
]);

let identityLiteralsCache: Array<[string, string]> | null = null;

/**
 * Literal strings that identify this machine's owner, longest first so a
 * hostname such as "Alexs-MacBook-Pro" is replaced before the username
 * inside it is.
 */
function identityLiterals(): Array<[string, string]> {
	if (identityLiteralsCache) {
		return identityLiteralsCache;
	}

	const entries: Array<[string, string]> = [];
	const add = (value: string | undefined, token: string) => {
		// Anything shorter than 3 characters matches too much ordinary text.
		if (!value || value.length < 3) return;
		// A name that collides with our own token vocabulary (a machine literally
		// called "host", an account named "root") would mangle descriptors
		// without hiding anything that isn't already hidden.
		if (TOKEN_VOCABULARY.has(value.toLowerCase())) return;
		if (entries.some(([existing]) => existing.toLowerCase() === value.toLowerCase())) return;
		entries.push([value, token]);
	};

	try {
		add(os.userInfo().username, '[user]');
	} catch {
		// userInfo() throws when there is no passwd entry (some containers)
	}
	try {
		const hostname = os.hostname();
		add(hostname, '[host]');
		add(hostname.split('.')[0], '[host]');
	} catch {
		// hostname unavailable
	}

	entries.sort((a, b) => b[0].length - a[0].length);
	identityLiteralsCache = entries;
	return entries;
}

/**
 * Strip paths, URLs, usernames, hostnames, and API keys out of arbitrary text.
 */
export function redactText(text: string): string {
	if (typeof text !== 'string' || text === '') {
		return text;
	}

	// Secrets first, and before the length cap: a support package is the one
	// artefact most likely to be attached to a public issue, and an API key that
	// survived into one is worse than any path this function was written for.
	// The scrubber lives with the credential layer, so there is one definition of
	// "looks like a key" rather than a second one drifting here.
	let result = redactSecrets(text);

	result = result.replace(TEXT_TARGET_RE, (match) => {
		if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(match)) return redactUrl(match);
		// Emails, ssh targets, and git remotes name a person, a machine, and a
		// repository, so nothing but a correlation id survives.
		if (ACCOUNT_RE.test(match)) return `[account#${fingerprint(match)}]`;
		return redactPath(match);
	});

	for (const [literal, token] of identityLiterals()) {
		result = result.replace(new RegExp(escapeRegExp(literal), 'gi'), token);
	}

	return result;
}

/**
 * Redact free text and cap its length. Long strings are prompts, file
 * contents, or conversation excerpts far more often than they are diagnostics.
 */
export function redactAndTruncate(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
	const sanitized = redactText(text);
	if (typeof sanitized !== 'string' || sanitized.length <= maxLength) {
		return sanitized;
	}
	return `${sanitized.slice(0, maxLength)} [TRUNCATED]`;
}

/**
 * Sanitize a log entry's message: removes embedded paths and identity, and
 * truncates overly long messages that likely contain prompts or conversation
 * content.
 */
export function sanitizeLogMessage(message: string): string {
	return redactAndTruncate(message);
}
