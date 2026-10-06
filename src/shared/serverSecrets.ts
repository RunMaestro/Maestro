/**
 * Secrets a server supplies to Maestro, by name.
 *
 * A bundle never carries a secret VALUE, only the names an agent or a webhook
 * needs. On a server the value comes from one of three places, checked in this
 * order:
 *
 *   1. `$CREDENTIALS_DIRECTORY/<NAME>` - a systemd credential
 *      (`LoadCredential=` / `SetCredential=`). systemd sets the variable for
 *      this service alone and mounts the directory private to it.
 *   2. `/run/secrets/<NAME>` - a Docker or Kubernetes secret file.
 *   3. The environment variable `<NAME>`.
 *
 * Files win over the environment on purpose. A file is the deliberate secret
 * channel: it is not visible in `/proc/<pid>/environ` or `docker inspect`, it
 * is not inherited by every child process, and an operator who mounted one
 * meant it. The environment is the convenience fallback, and a stale value
 * left in a unit file or a shell must not silently shadow the secret the
 * operator just rotated in its file. systemd comes before `/run/secrets`
 * because it is scoped to this one service, while `/run/secrets` is a shared
 * mount convention.
 *
 * A file that EXISTS is the answer, even when it is unusable (unreadable, a
 * directory, empty, over the size cap): the lookup reports the problem rather
 * than falling through to the environment, for the same reason.
 *
 * Values are returned to the caller and nowhere else. Nothing here logs, and
 * every problem names the secret and the path, never the content. Callers
 * must keep it that way: a value belongs in one child's environment and in no
 * log, error message, database row or status payload.
 *
 * Electron-free and dependency-free on purpose: the standalone Cue engine, the
 * CLI verbs, the launch plan and the bundle importer all import it.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The variable systemd sets to a service's credentials directory. */
export const CREDENTIALS_DIRECTORY_ENV_VAR = 'CREDENTIALS_DIRECTORY';
/** Where Docker and Kubernetes mount secret files. */
export const RUN_SECRETS_DIR = '/run/secrets';
/**
 * Largest secret file read. Generous for any token or key, and well under the
 * kernel's per-variable limit (128 KiB) for something that ends up in an
 * environment.
 */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/**
 * A secret name is an environment variable name. That is also what makes it
 * safe as a file name: no separator, no `.` or `..`, nothing to escape the
 * secrets directory with.
 */
const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SecretSource = 'credentials' | 'run-secrets' | 'env';
export type SecretProblem = 'invalid-name' | 'unreadable' | 'not-a-file' | 'too-large' | 'empty';

export interface SecretLookupOptions {
	/** Environment to read `CREDENTIALS_DIRECTORY` and the fallback values from. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Override the `/run/secrets` directory; `null` disables it. Tests use this. */
	runSecretsDir?: string | null;
}

export type SecretLookup =
	| { status: 'found'; value: string; source: SecretSource }
	| { status: 'missing' }
	| { status: 'unusable'; problem: SecretProblem; path?: string };

export function isValidSecretName(name: string): boolean {
	return SECRET_NAME_PATTERN.test(name);
}

/**
 * One trailing line ending is dropped: `echo token > file` and most secret
 * tooling write one, and a token with a newline on the end is rejected by
 * every API it is sent to. Only one, so a value that genuinely ends in blank
 * lines keeps the rest.
 */
function trimOneLineEnding(text: string): string {
	if (text.endsWith('\r\n')) return text.slice(0, -2);
	if (text.endsWith('\n')) return text.slice(0, -1);
	return text;
}

/** `undefined` when no file is there; a lookup result when one is. */
function readSecretFile(dir: string, name: string, source: SecretSource): SecretLookup | undefined {
	const file = path.join(dir, name);
	let stat: fs.Stats;
	try {
		// Follows symlinks, which is how Kubernetes mounts secret files.
		stat = fs.statSync(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
		return { status: 'unusable', problem: 'unreadable', path: file };
	}
	if (!stat.isFile()) return { status: 'unusable', problem: 'not-a-file', path: file };
	if (stat.size > MAX_SECRET_FILE_BYTES) {
		return { status: 'unusable', problem: 'too-large', path: file };
	}
	let text: string;
	try {
		text = fs.readFileSync(file, 'utf8');
	} catch {
		return { status: 'unusable', problem: 'unreadable', path: file };
	}
	const value = trimOneLineEnding(text);
	if (value === '') return { status: 'unusable', problem: 'empty', path: file };
	return { status: 'found', value, source };
}

/** Look one secret up: systemd credential, then `/run/secrets`, then the environment. */
export function lookupSecret(name: string, options: SecretLookupOptions = {}): SecretLookup {
	if (!isValidSecretName(name)) return { status: 'unusable', problem: 'invalid-name' };
	const env = options.env ?? process.env;

	const credentialsDir = env[CREDENTIALS_DIRECTORY_ENV_VAR];
	if (credentialsDir && path.isAbsolute(credentialsDir)) {
		const found = readSecretFile(credentialsDir, name, 'credentials');
		if (found) return found;
	}
	const runSecretsDir =
		options.runSecretsDir === undefined ? RUN_SECRETS_DIR : options.runSecretsDir;
	if (runSecretsDir) {
		const found = readSecretFile(runSecretsDir, name, 'run-secrets');
		if (found) return found;
	}
	const fromEnv = env[name];
	if (fromEnv !== undefined && fromEnv !== '') {
		return { status: 'found', value: fromEnv, source: 'env' };
	}
	return { status: 'missing' };
}

export interface ResolvedSecrets {
	/** Name -> value, for the names that were found. Never log this. */
	values: Record<string, string>;
	/** Names found, with where each came from (safe to log). */
	found: { name: string; source: SecretSource }[];
	/** Names set nowhere. */
	missing: string[];
	/** Names that cannot be used, and why (safe to log: no values). */
	unusable: { name: string; problem: SecretProblem; path?: string }[];
}

/** Look several secrets up at once; names are de-duplicated and reported in sorted order. */
export function resolveSecrets(
	names: readonly string[],
	options: SecretLookupOptions = {}
): ResolvedSecrets {
	const result: ResolvedSecrets = { values: {}, found: [], missing: [], unusable: [] };
	for (const name of [...new Set(names)].sort()) {
		const lookup = lookupSecret(name, options);
		if (lookup.status === 'found') {
			result.values[name] = lookup.value;
			result.found.push({ name, source: lookup.source });
		} else if (lookup.status === 'missing') {
			result.missing.push(name);
		} else {
			result.unusable.push({ name, problem: lookup.problem, path: lookup.path });
		}
	}
	return result;
}

/** One line naming what is wrong with a secret, without its value. */
export function describeSecretProblem(entry: {
	name: string;
	problem: SecretProblem;
	path?: string;
}): string {
	const where = entry.path ? ` (${entry.path})` : '';
	switch (entry.problem) {
		case 'invalid-name':
			return `${entry.name} is not a valid secret name`;
		case 'not-a-file':
			return `${entry.name}${where} is not a regular file`;
		case 'too-large':
			return `${entry.name}${where} is larger than ${MAX_SECRET_FILE_BYTES} bytes`;
		case 'empty':
			return `${entry.name}${where} is empty`;
		default:
			return `${entry.name}${where} could not be read`;
	}
}
