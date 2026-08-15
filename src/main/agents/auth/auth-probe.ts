/**
 * Provider Auth Probe
 *
 * Answers one question per credential identity: is this login still good? Every
 * supported provider ships a real status subcommand, so this needs no PTY, no
 * TUI driving, and no blind-typing of `/login` - a plain `execFileNoThrow` with
 * the identity's env applied, a short timeout, and a parser per provider is the
 * whole probe.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. **Never report `logged-out` on a probe that could not run.** A missing
 *    binary, a timeout, an SSH host that is down, an unparseable payload, and a
 *    provider with no status command are all `unknown`. A false "you are logged
 *    out" badge fired at someone who is perfectly logged in is a worse bug than
 *    no detection at all, because it sends them to re-run a login they did not
 *    need.
 * 2. **Never probe a non-`oauth` identity.** `api-key`, `gateway`,
 *    `cloud-provider`, and `unknown` kinds resolve to `unsupported` without
 *    spawning anything. `claude auth status` reports the OAuth state of a config
 *    directory, which says nothing about whether the `ANTHROPIC_AUTH_TOKEN`
 *    pointing at a third-party gateway is still valid, so probing those would
 *    produce a confidently wrong answer.
 *
 * Verified against the CLIs installed on a dev machine on 2026-08-15; the
 * findings (including exit codes, which are NOT uniform) are recorded in
 * `docs/architecture/provider-auth/survey.md` §4.
 */

import * as os from 'os';

import type { CredentialIdentity, ProviderAuthSnapshot } from '../../../shared/providerAuth';
import { sshRemoteIdFromHost } from '../../../shared/providerAuth';
import { stripAnsiCodes } from '../../../shared/stringUtils';
import type { AgentSshRemoteConfig } from '../../../shared/types';
import { execFileNoThrow } from '../../utils/execFile';
import { logger } from '../../utils/logger';
import type { SshRemoteSettingsStore } from '../../utils/ssh-remote-resolver';
import { wrapSpawnWithSsh } from '../../utils/ssh-spawn-wrapper';
import { getAgentDefinition } from '../definitions';

const LOG_CONTEXT = '[AuthProbe]';

/**
 * Wall-clock budget for one LOCAL probe. Every status command measured returns
 * in well under a second; the width absorbs a cold Node start and a slow disk.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/**
 * Wall-clock budget for a probe that runs over SSH.
 *
 * A remote probe pays for TCP setup, the SSH handshake, key agent round trips,
 * and a login shell before the status command starts, and a `ConnectTimeout`
 * that has not been configured on the remote can sit for tens of seconds. The
 * local budget applied to that produces `unknown` for a host that was merely
 * slow, so the remote one is deliberately several times wider: a probe is a
 * background question, and the cost of waiting longer is nothing next to the
 * cost of an answer nobody can trust. Still bounded, because an unreachable
 * host must resolve rather than hang.
 */
export const SSH_PROBE_TIMEOUT_MS = 60_000;

/**
 * `$BROWSER` neutralizer, copied from `claude-usage-sampler.ts` for the same
 * reason: an unattended background probe must never be able to pop an OAuth
 * window. `claude auth status` does not open one (verified), so this is a belt
 * on top of braces - and on Windows the nonexistent path fails closed the same
 * way rather than launching anything.
 */
const NO_BROWSER_COMMAND = '/usr/bin/true';

/** How much probe output to keep when reporting an unparseable response. */
const MAX_DETAIL_SNIPPET = 160;

/**
 * The exit code the ssh client reserves for its OWN failures (unreachable host,
 * refused connection, rejected key, unknown host key). A remote command's real
 * exit code passes through untouched, so 255 from an SSH probe means the status
 * command never ran - it is a transport failure, not a login verdict.
 */
const SSH_TRANSPORT_EXIT_CODE = 255;

/**
 * Transport failures that do NOT come back as 255, mostly because a login shell
 * on the far side swallowed the exit code, plus the messages `ssh` writes before
 * it gives up. Matched against stderr only for a probe that used SSH.
 *
 * This exists so the per-provider parsers never see connection noise. Without
 * it, `codex login status` output containing an ssh error would be handed to a
 * matcher whose logged-out branch is a plain substring test - one banner line
 * away from telling the user their perfectly good login had expired.
 */
const SSH_TRANSPORT_FAILURE_RE =
	/\bssh:\s|could not resolve hostname|connection (?:refused|closed|timed out|reset)|no route to host|permission denied \(|host key verification failed|kex_exchange_identification|operation timed out|network is unreachable/i;

export interface ProbeCredentialOptions {
	/** Absolute path to the provider binary on the host that runs the probe. */
	binaryPath: string;
	/**
	 * The EFFECTIVE env for the identity (agent-level merged under session-level,
	 * via `mergeEffectiveEnv`). Layered over `process.env` for a local probe;
	 * passed to the remote shell for an SSH probe. NEVER logged.
	 */
	env: Record<string, string>;
	/**
	 * Wall-clock budget. Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS} locally and
	 * to the wider {@link SSH_PROBE_TIMEOUT_MS} when the probe runs over SSH.
	 */
	timeoutMs?: number;
	/** Working directory for the spawn. Defaults to the home directory. */
	cwd?: string;
	/** Session-level SSH config, when the agent runs on a remote host. */
	sshRemoteConfig?: AgentSshRemoteConfig;
	/** Store adapter used to resolve {@link sshRemoteConfig}. */
	sshStore?: SshRemoteSettingsStore;
	/** Clock override for tests. */
	now?: () => number;
}

/** Outcome of one status-command spawn. */
interface ProbeRun {
	stdout: string;
	stderr: string;
	exitCode: number | string;
	/**
	 * Set when the command could not be RUN at all (missing binary, timeout,
	 * unresolvable SSH remote). Distinct from a non-zero exit, which means the
	 * command ran and had something to say. Callers must map this to `unknown`.
	 */
	spawnFailure?: string;
}

// ============================================================================
// Provider output matchers
// ============================================================================

/**
 * `claude auth status --json` reports which API the CLI is actually talking to.
 * Anything other than this value means the config directory is overridden onto
 * an API-key or cloud-provider path the resolver could not see from the env, so
 * the OAuth state it reports is not the credential in play.
 */
const CLAUDE_FIRST_PARTY_PROVIDER = 'firstparty';

/**
 * `codex login status` prints `Not logged in` and exits 1 when there is no
 * login. Checked BEFORE {@link CODEX_LOGGED_IN_RE}, since that string contains
 * the logged-in phrase as a substring.
 */
const CODEX_LOGGED_OUT_RE = /\bnot\s+logged\s+in\b/i;

/**
 * `codex login status` prints `Logged in using ChatGPT` and exits 0. Anchored to
 * the start of a line so the negated form above cannot match it.
 */
const CODEX_LOGGED_IN_RE = /(^|\n)\s*logged\s+in\b[^\n]*/i;

/**
 * `opencode auth list` closes with a `N credentials` footer (`1 credentials`,
 * `0 credentials`). That count, not an exit code, is the login signal: the
 * command exits 0 either way.
 */
const OPENCODE_CREDENTIAL_COUNT_RE = /(\d+)\s+credentials?\b/i;

/**
 * Why a given non-`oauth` kind is not probed, phrased for the UI. The `oauth`
 * entry is never read - it exists so adding a {@link CredentialIdentity.kind}
 * fails the type check here instead of silently falling through to an empty
 * explanation.
 */
const UNSUPPORTED_KIND_DETAIL: Record<CredentialIdentity['kind'], string> = {
	oauth: '',
	'api-key': 'Credential is an API key, so there is no login state to check',
	gateway: 'Credential belongs to a third-party gateway, not to an interactive login',
	'cloud-provider': 'Credentials come from the cloud provider SDK chain, not from the agent CLI',
	unknown: 'No login probe is available for this provider',
};

// ============================================================================
// Snapshot helpers
// ============================================================================

function buildSnapshot(
	identity: CredentialIdentity,
	status: ProviderAuthSnapshot['status'],
	parts: { detail?: string; accountLabel?: string },
	now: () => number
): ProviderAuthSnapshot {
	const snapshot: ProviderAuthSnapshot = {
		identity,
		status,
		checkedAt: now(),
		source: 'probe',
	};
	if (parts.detail !== undefined && parts.detail !== '') {
		snapshot.detail = parts.detail;
	}
	if (parts.accountLabel !== undefined && parts.accountLabel !== '') {
		snapshot.accountLabel = parts.accountLabel;
	}
	return snapshot;
}

/**
 * Log a probe that did not produce a definite answer. Deliberately narrow: the
 * identity key, the provider, and a reason. The resolved env is NEVER included -
 * it can carry `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, and friends.
 */
function warnProbe(identity: CredentialIdentity, reason: string, exitCode?: number | string): void {
	logger.warn('Auth probe did not return a definite status', LOG_CONTEXT, {
		key: identity.key,
		provider: identity.provider,
		reason,
		...(exitCode === undefined ? {} : { exitCode }),
	});
}

/** First non-empty line of a command's output, trimmed and length-capped. */
function firstMeaningfulLine(text: string): string {
	const line = stripAnsiCodes(text)
		.split(/\r?\n/)
		.map((candidate) => candidate.trim())
		.find((candidate) => candidate !== '');
	if (!line) {
		return '';
	}
	return line.length > MAX_DETAIL_SNIPPET ? `${line.slice(0, MAX_DETAIL_SNIPPET)}...` : line;
}

// ============================================================================
// Spawn layer
// ============================================================================

/**
 * Run a provider status command and normalize every way it can fail.
 *
 * Spawn-level failures (`ENOENT`, `ETIMEDOUT`, an unresolvable SSH remote) come
 * back as {@link ProbeRun.spawnFailure} rather than as output, so no parser can
 * mistake "we never got an answer" for "the answer was no".
 */
async function runStatusCommand(
	identity: CredentialIdentity,
	args: string[],
	opts: ProbeCredentialOptions
): Promise<ProbeRun> {
	const cwd = opts.cwd ?? os.homedir();
	let command = opts.binaryPath;
	let commandArgs = args;
	let execCwd = cwd;
	// The identity's env layered over the parent env, so PATH and friends survive
	// while the credential-selecting vars are exactly the ones the agent spawns
	// with.
	let execEnv: NodeJS.ProcessEnv = {
		...process.env,
		...opts.env,
		BROWSER: NO_BROWSER_COMMAND,
	};

	// The identity's host is the machine that OWNS this credential, and it is what
	// the stored snapshot gets filed under. If it disagrees with the SSH config
	// the caller handed over, the probe would answer a question about one machine
	// and record it against another. Both directions are refused rather than
	// guessed at.
	const identityRemoteId = sshRemoteIdFromHost(identity.host);
	const sshEnabled = opts.sshRemoteConfig?.enabled === true;
	if (identityRemoteId !== null && !sshEnabled) {
		return {
			stdout: '',
			stderr: '',
			exitCode: 'ESSHMISSING',
			spawnFailure: `credential lives on ssh remote "${identityRemoteId}" but no ssh config was supplied; refusing to probe the local host`,
		};
	}
	if (identityRemoteId === null && sshEnabled) {
		return {
			stdout: '',
			stderr: '',
			exitCode: 'ESSHUNEXPECTED',
			spawnFailure:
				'credential is local but an ssh remote was supplied; refusing to report a remote host as this identity',
		};
	}

	const timeoutMs =
		opts.timeoutMs ?? (sshEnabled ? SSH_PROBE_TIMEOUT_MS : DEFAULT_PROBE_TIMEOUT_MS);

	if (sshEnabled) {
		// The user explicitly opted this agent into SSH. Running the probe locally
		// would read a completely different machine's credentials and report them
		// as this identity's, so an unresolvable remote is a failure, not a
		// fallback. Same rule as `sshUnresolvedFailure()` in the CLI spawner.
		if (!opts.sshStore) {
			return {
				stdout: '',
				stderr: '',
				exitCode: 'ESSHSTORE',
				spawnFailure: 'ssh remote configured but no ssh store was supplied',
			};
		}
		try {
			const wrapped = await wrapSpawnWithSsh(
				{
					command,
					args,
					cwd,
					// The effective env (agent-level under session-level) travels inside
					// the remote command line, so the remote CLI reads the same
					// CLAUDE_CONFIG_DIR / CODEX_HOME the agent itself would spawn with.
					customEnvVars: opts.env,
					// Bare binary name on the far side, never the local resolved path or
					// a local `customPath` override: those name a file on THIS machine.
					// Same convention as every other SSH spawn site.
					agentBinaryName: getAgentDefinition(identity.provider)?.binaryName,
				},
				opts.sshRemoteConfig,
				opts.sshStore
			);
			if (!wrapped.sshRemoteUsed) {
				return {
					stdout: '',
					stderr: '',
					exitCode: 'ESSHUNRESOLVED',
					spawnFailure: 'ssh remote could not be resolved; refusing to probe the local host',
				};
			}
			if (wrapped.sshRemoteUsed.id !== identityRemoteId) {
				return {
					stdout: '',
					stderr: '',
					exitCode: 'ESSHMISMATCH',
					spawnFailure: `ssh config resolved to remote "${wrapped.sshRemoteUsed.id}" but the credential belongs to "${identityRemoteId}"`,
				};
			}
			command = wrapped.command;
			commandArgs = wrapped.args;
			execCwd = wrapped.cwd;
			// The remote env is baked into the SSH command line by the wrapper, so
			// only the local process env (which carries the ssh binary's own PATH and
			// SSH_AUTH_SOCK) is passed here.
			execEnv = { ...process.env };
		} catch (error) {
			return {
				stdout: '',
				stderr: '',
				exitCode: 'ESSHWRAP',
				spawnFailure: `ssh wrap failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	const result = await execFileNoThrow(command, commandArgs, execCwd, {
		env: execEnv,
		timeout: timeoutMs,
	});

	// `execFileNoThrow` returns a numeric exit code when the process ran and a
	// string errno ('ENOENT', 'EACCES', 'ETIMEDOUT') when it never did.
	if (typeof result.exitCode === 'string') {
		return {
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			spawnFailure:
				result.exitCode === 'ETIMEDOUT'
					? `status command timed out after ${timeoutMs}ms${sshEnabled ? ' (remote host did not answer in time)' : ''}`
					: `status command could not be run (${result.exitCode})`,
		};
	}

	// An ssh that never reached the provider is a failure to RUN the probe, so it
	// is caught here and never reaches a parser. An unreachable host is `unknown`;
	// it is emphatically not "you are logged out".
	if (sshEnabled) {
		const transportFailure = describeSshTransportFailure(result.exitCode, result.stderr);
		if (transportFailure) {
			return {
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				spawnFailure: transportFailure,
			};
		}
	}

	return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

/**
 * Why an SSH probe never reached the provider, or null when the remote command
 * actually ran (whatever it then had to say).
 *
 * The returned string is shown to the user, so it carries the ssh client's own
 * first line when there is one - "the host is down" is far more actionable than
 * "unknown". stdout is deliberately not consulted: it is the provider's channel,
 * and matching connection words there would let a provider that merely printed
 * the phrase read as a dead host.
 */
function describeSshTransportFailure(exitCode: number, stderr: string): string | null {
	const text = stripAnsiCodes(stderr);
	const matched = SSH_TRANSPORT_FAILURE_RE.test(text);
	if (exitCode !== SSH_TRANSPORT_EXIT_CODE && !matched) {
		return null;
	}
	const reason = firstMeaningfulLine(text);
	return reason
		? `ssh could not run the status command on the remote host: ${reason}`
		: `ssh could not run the status command on the remote host (exit ${exitCode})`;
}

// ============================================================================
// Per-provider probes
// ============================================================================

/** The subset of `claude auth status --json` this parser reads. */
interface ClaudeAuthStatusPayload {
	loggedIn?: unknown;
	authMethod?: unknown;
	apiProvider?: unknown;
	email?: unknown;
	orgName?: unknown;
	subscriptionType?: unknown;
}

/**
 * Pull the first JSON object out of a command's stdout.
 *
 * `claude auth status --json` pretty-prints across several lines, so the
 * line-oriented scan `claude-usage-sampler.ts` uses would not find it. Slicing
 * from the first `{` to the last `}` also tolerates a `(node:1234)
 * DeprecationWarning:` prefix or a trailing blank line.
 */
function extractJsonObject(stdout: string): unknown | null {
	const start = stdout.indexOf('{');
	const end = stdout.lastIndexOf('}');
	if (start === -1 || end <= start) {
		return null;
	}
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return null;
	}
}

/**
 * claude-code: `claude auth status --json`.
 *
 * The exit code is deliberately ignored. Verified 2026-08-15: the command exits
 * 0 when logged in and 1 when logged out, but emits the same well-formed JSON
 * both times, so gating on the exit code would throw away a perfectly good
 * `loggedIn: false` reading.
 */
async function probeClaudeCode(
	identity: CredentialIdentity,
	opts: ProbeCredentialOptions,
	now: () => number
): Promise<ProviderAuthSnapshot> {
	const run = await runStatusCommand(identity, ['auth', 'status', '--json'], opts);
	if (run.spawnFailure) {
		warnProbe(identity, run.spawnFailure, run.exitCode);
		return buildSnapshot(identity, 'unknown', { detail: run.spawnFailure }, now);
	}

	const payload = extractJsonObject(run.stdout) as ClaudeAuthStatusPayload | null;
	if (!payload || typeof payload !== 'object') {
		warnProbe(identity, 'claude auth status returned unparseable output', run.exitCode);
		return buildSnapshot(
			identity,
			'unknown',
			{ detail: 'claude auth status returned output this build could not parse' },
			now
		);
	}

	// A non-first-party apiProvider means the config directory is wired to an
	// API key or a cloud provider that the env-based resolver never saw. Its
	// OAuth state is not the credential in play, and `claude auth login` is not
	// the remedy, so this is `unsupported` rather than a login verdict.
	const apiProvider = typeof payload.apiProvider === 'string' ? payload.apiProvider : '';
	if (apiProvider !== '' && apiProvider.toLowerCase() !== CLAUDE_FIRST_PARTY_PROVIDER) {
		return buildSnapshot(
			identity,
			'unsupported',
			{
				detail: `Config directory is bound to the "${apiProvider}" provider, not an interactive login`,
			},
			now
		);
	}

	if (payload.loggedIn === true) {
		const parts = [payload.email, payload.orgName, payload.subscriptionType].filter(
			(part): part is string => typeof part === 'string' && part.trim() !== ''
		);
		return buildSnapshot(
			identity,
			'authenticated',
			{ detail: parts.join(' · '), accountLabel: identity.label },
			now
		);
	}

	if (payload.loggedIn === false) {
		return buildSnapshot(
			identity,
			'logged-out',
			{ detail: 'claude auth status reports no active login', accountLabel: identity.label },
			now
		);
	}

	warnProbe(identity, 'claude auth status omitted loggedIn', run.exitCode);
	return buildSnapshot(
		identity,
		'unknown',
		{ detail: 'claude auth status did not report a login state' },
		now
	);
}

/**
 * codex: `codex login status`.
 *
 * Plain text, not JSON. Verified 2026-08-15: `Logged in using ChatGPT` with exit
 * 0, `Not logged in` with exit 1.
 */
async function probeCodex(
	identity: CredentialIdentity,
	opts: ProbeCredentialOptions,
	now: () => number
): Promise<ProviderAuthSnapshot> {
	const run = await runStatusCommand(identity, ['login', 'status'], opts);
	if (run.spawnFailure) {
		warnProbe(identity, run.spawnFailure, run.exitCode);
		return buildSnapshot(identity, 'unknown', { detail: run.spawnFailure }, now);
	}

	const text = stripAnsiCodes(`${run.stdout}\n${run.stderr}`);

	// Order matters: "Not logged in" contains the logged-in phrase.
	if (CODEX_LOGGED_OUT_RE.test(text)) {
		return buildSnapshot(
			identity,
			'logged-out',
			{ detail: 'codex login status reports no active login', accountLabel: identity.label },
			now
		);
	}

	const loggedIn = CODEX_LOGGED_IN_RE.exec(text);
	if (loggedIn && run.exitCode === 0) {
		return buildSnapshot(
			identity,
			'authenticated',
			{ detail: loggedIn[0].trim(), accountLabel: identity.label },
			now
		);
	}

	warnProbe(identity, 'codex login status output was not recognized', run.exitCode);
	return buildSnapshot(
		identity,
		'unknown',
		{
			detail:
				firstMeaningfulLine(text) ||
				'codex login status returned output this build could not parse',
		},
		now
	);
}

/**
 * opencode: `opencode auth list`.
 *
 * Non-interactive and exits 0 whether or not anything is stored (`opencode auth
 * login` is the interactive picker and is never run here). The signal is the
 * `N credentials` footer.
 *
 * Best-effort by construction, and coarser than the other two: opencode keeps
 * every provider's credential in one `auth.json`, so this answers "does this
 * config directory hold any credential at all", not "is the provider this agent
 * will use logged in". It can also be slow on a first run against a fresh data
 * directory, which triggers a one-time database migration - that lands on the
 * timeout and resolves to `unknown`, which is the correct side to fail on.
 */
async function probeOpenCode(
	identity: CredentialIdentity,
	opts: ProbeCredentialOptions,
	now: () => number
): Promise<ProviderAuthSnapshot> {
	const run = await runStatusCommand(identity, ['auth', 'list'], opts);
	if (run.spawnFailure) {
		warnProbe(identity, run.spawnFailure, run.exitCode);
		return buildSnapshot(identity, 'unknown', { detail: run.spawnFailure }, now);
	}

	// The output is ANSI-decorated box drawing; strip before matching.
	const text = stripAnsiCodes(`${run.stdout}\n${run.stderr}`);
	const match = run.exitCode === 0 ? OPENCODE_CREDENTIAL_COUNT_RE.exec(text) : null;
	if (!match) {
		warnProbe(identity, 'opencode auth list output was not recognized', run.exitCode);
		return buildSnapshot(
			identity,
			'unknown',
			{ detail: 'opencode auth list returned output this build could not parse' },
			now
		);
	}

	const count = Number.parseInt(match[1], 10);
	if (count > 0) {
		return buildSnapshot(
			identity,
			'authenticated',
			{
				detail: `${count} stored credential${count === 1 ? '' : 's'}`,
				accountLabel: identity.label,
			},
			now
		);
	}

	return buildSnapshot(
		identity,
		'logged-out',
		{ detail: 'opencode auth list reports no stored credentials', accountLabel: identity.label },
		now
	);
}

// ============================================================================
// Dispatcher
// ============================================================================

/**
 * Determine the login state of one credential identity.
 *
 * Never throws and never spawns for an identity it cannot probe. Every caller
 * gets a snapshot back, including the ones where the honest answer is "we do not
 * know" - see the two rules in the module docblock.
 */
export async function probeCredential(
	identity: CredentialIdentity,
	opts: ProbeCredentialOptions
): Promise<ProviderAuthSnapshot> {
	const now = opts.now ?? Date.now;

	// Rule 2, enforced ahead of the dispatch so no provider branch can forget it.
	if (identity.kind !== 'oauth') {
		return buildSnapshot(
			identity,
			'unsupported',
			{ detail: UNSUPPORTED_KIND_DETAIL[identity.kind] },
			now
		);
	}

	switch (identity.provider) {
		case 'claude-code':
			return probeClaudeCode(identity, opts, now);
		case 'codex':
			return probeCodex(identity, opts, now);
		case 'opencode':
			return probeOpenCode(identity, opts, now);
		case 'copilot-cli':
			// `copilot --help` lists login / mcp / plugin / init / update / version
			// and no status verb (re-verified 2026-08-15), and `copilot login` runs
			// an interactive device flow. There is nothing safe to spawn, so the
			// honest answer is `unknown`, not a guess.
			return buildSnapshot(
				identity,
				'unknown',
				{ detail: 'GitHub Copilot CLI has no non-interactive status command' },
				now
			);
		default:
			// factory-droid and anything else: no verified auth surface. Must never
			// render as logged-out.
			return buildSnapshot(
				identity,
				'unsupported',
				{ detail: 'No login probe is available for this provider' },
				now
			);
	}
}
