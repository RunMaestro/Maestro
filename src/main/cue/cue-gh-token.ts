/**
 * The GitHub token Cue's own `gh` calls run with.
 *
 * gh reads its token from `GH_TOKEN`, then `GITHUB_TOKEN`, then its stored
 * login (`gh auth login`). On a server the token is usually a secret file
 * (a systemd credential or a Docker secret), which gh never looks at, so each
 * name is looked up the way every server secret is (`lookupSecret`:
 * `$CREDENTIALS_DIRECTORY`, then `/run/secrets`, then the environment) and
 * what is found is put in the environment of that one gh call. gh's own
 * precedence then decides between the two names and the stored login.
 *
 * Resolved per call, not once per engine start, so a rotated secret file is
 * picked up by the next poll without a restart. The value only ever goes into
 * the child's env object: never into `process.env` (agents inherit that, and
 * this token is Cue's, not theirs), never into a log line or error message.
 */

import {
	describeSecretProblem,
	lookupSecret,
	type SecretLookupOptions,
} from '../../shared/serverSecrets';

/** The names gh reads a token from, in gh's own precedence order. */
export const GH_TOKEN_SECRET_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const;

export interface GhEnv {
	/** Environment for the gh child process. Never log it. */
	env: NodeJS.ProcessEnv;
	/** Token values placed in `env`, for scrubbing output. Never log them. */
	tokens: string[];
	/** One line per secret file that exists but cannot be used (names and paths only). */
	problems: string[];
}

/**
 * Build the environment for one gh call from `base`. A token secret file that
 * exists but is unusable removes that name from the child's environment
 * rather than falling back to a stale variable, the same rule `lookupSecret`
 * applies everywhere, and is reported in `problems`.
 */
export function buildGhEnv(
	base: NodeJS.ProcessEnv,
	options: Pick<SecretLookupOptions, 'runSecretsDir'> = {}
): GhEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	const tokens: string[] = [];
	const problems: string[] = [];
	for (const name of GH_TOKEN_SECRET_NAMES) {
		const lookup = lookupSecret(name, { env: base, runSecretsDir: options.runSecretsDir });
		if (lookup.status === 'found') {
			env[name] = lookup.value;
			tokens.push(lookup.value);
		} else if (lookup.status === 'unusable') {
			delete env[name];
			problems.push(describeSecretProblem({ name, ...lookup }));
		}
	}
	return { env, tokens, problems };
}

/** Replace every occurrence of each token in `text`. */
export function redactGhTokens(text: string, tokens: readonly string[]): string {
	let out = text;
	for (const token of tokens) {
		if (token) out = out.split(token).join('[redacted]');
	}
	return out;
}
