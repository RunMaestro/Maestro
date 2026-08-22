/**
 * AuthRecoveryModal - the surface that repairs one expired login.
 *
 * A blocked account is fixed by running one command and finishing a browser
 * flow, so this modal is that command already running, in a terminal, for the
 * ACCOUNT the user is actually blocked on. The alternatives are worse: a bare
 * terminal tab can be scrolled away from and lost, and injecting the command
 * into an existing terminal fights whatever the user had running there.
 *
 * Two things the header must never get wrong:
 *
 *   - WHICH account. Signing into `.claude-smash` when `.claude-gmail` is the
 *     blocked one produces a successful-looking flow that fixes nothing, and the
 *     user does not find out until the next prompt burns. The account's own
 *     directory name is on screen the whole time.
 *   - HOW MANY agents this unblocks. The user's question is never "which key
 *     expired" but "what of mine is broken", so the count answers it up front.
 *
 * Content-driven by design (the user reads the terminal and types into it), so
 * no `select-none` on the root - see UI-PATTERNS.md -> Text Selection in Modals.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
	ExternalLink,
	KeyRound,
	RefreshCw,
	ShieldAlert,
	Terminal as TerminalIcon,
} from 'lucide-react';
import { Modal } from './ui/Modal';
import { EscCloseButton } from './ui/EscCloseButton';
import { XTerminal } from './XTerminal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { useSettingsStore } from '../stores/settingsStore';
import { verifyAuthRecovery } from '../services/authRecovery';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	buildLoginRunSessionId,
	resolveLoginCommand,
	sshRemoteIdFromHost,
} from '../../shared/providerAuth';
import type { CredentialIdentity, CredentialKind } from '../../shared/providerAuth';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { generateId } from '../utils/ids';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { logger } from '../utils/logger';
import { openUrl } from '../utils/openUrl';
import type { Session, Theme } from '../types';

const LOG_CONTEXT = '[AuthRecovery]';

/**
 * How much of the login's output to keep while looking for a sign-in URL.
 *
 * Only enough to survive a URL split across PTY chunks. The terminal itself
 * holds the scrollback; this buffer exists to match a regex against, and an
 * unbounded one would grow for as long as the modal is open.
 */
const URL_SCAN_BUFFER_CHARS = 8000;

/**
 * How long a remote login may print nothing URL-shaped before the modal offers
 * the manual escape hatch. Long enough that a slow SSH handshake plus a CLI
 * banner does not trip it, short enough that a user is not left watching a
 * terminal that will never produce a link.
 */
const REMOTE_URL_WAIT_MS = 25_000;

// ============================================================================
// Helpers (exported for tests)
// ============================================================================

/** Plain-language name for a credential kind, for the header line. */
export function describeCredentialKind(kind: CredentialKind): string {
	switch (kind) {
		case 'oauth':
			return 'browser sign-in';
		case 'api-key':
			return 'API key';
		case 'gateway':
			return 'gateway token';
		case 'cloud-provider':
			return 'cloud credentials';
		default:
			return 'unrecognized credential';
	}
}

/**
 * What to tell a user whose credential CANNOT be repaired by signing in.
 *
 * Mirrors the remedies `authFailureFor()` in `stores/providerAuthStore.ts`
 * records: a rejected API key, a gateway operator's outage, and a stale Bedrock
 * role are three different problems, and none of them is fixed by a login. The
 * honest answer plus where to go is worth more than a button that cannot work.
 */
export function describeCredentialRemedy(identity: CredentialIdentity): {
	title: string;
	body: string;
} {
	const provider = getAgentDisplayName(identity.provider);
	switch (identity.kind) {
		case 'api-key':
			return {
				title: 'This account uses an API key, not a sign-in',
				body: `${identity.envVarName ?? 'The API key'} is what ${provider} presents, so signing in cannot repair it. Replace the key in Settings -> Agents (agent-level) or in this agent's own environment variables, then send a prompt again.`,
			};
		case 'gateway':
			return {
				title: `Requests go to ${identity.label}, not to the provider`,
				body: `${identity.envVarName ?? 'A base-URL override'} points ${provider} at ${identity.label}, so the credential belongs to that operator. Check the token they issued you, or clear the override to go back to the first-party account.`,
			};
		case 'cloud-provider':
			return {
				title: `${identity.label} credentials come from the cloud SDK`,
				body: `${provider} is configured for ${identity.label}, which reads its credentials from the cloud provider's own chain (profile, role, or metadata service) rather than from the CLI. Refresh them there - for example with your cloud CLI's login command - then send a prompt again.`,
			};
		default:
			return {
				title: 'No sign-in flow is known for this credential',
				body: `Maestro has no verified login command for ${provider}, so it will not guess at one. Repair the credential the way ${provider} documents, then send a prompt again.`,
			};
	}
}

/** http(s) URLs, minus the characters that bracket one rather than belong to it. */
const LOGIN_URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;

/** Punctuation a CLI puts AFTER a URL, never inside one. */
const TRAILING_PUNCT = /[.,;:!?)\]}'"`]+$/;

/**
 * The sign-in URL a login command printed, or null if it has not printed one.
 *
 * The far side of an SSH login cannot open a browser, so the URL in its output
 * is the only way through the flow: it has to become something the user can
 * click HERE. The text arrives as raw PTY output, so the escape sequences the
 * CLI used to color the link are stripped first - a URL wrapped in them matches
 * nothing otherwise.
 *
 * The LAST match wins. A flow that prints a docs link before its sign-in link
 * would otherwise hand the user the wrong one, and a URL still arriving in
 * chunks is replaced by its longer self on the next chunk.
 */
export function extractLoginUrl(text: string): string | null {
	const plain = stripAnsiCodes(text);
	LOGIN_URL_REGEX.lastIndex = 0;
	const matches = plain.match(LOGIN_URL_REGEX);
	if (!matches || matches.length === 0) return null;
	const url = matches[matches.length - 1].replace(TRAILING_PUNCT, '');
	return url.length > 0 ? url : null;
}

// ============================================================================
// Component
// ============================================================================

export interface AuthRecoveryModalProps {
	/** The credential being repaired. Everything on screen describes THIS one. */
	identity: CredentialIdentity;
	/** Every agent blocked by it, in Left Bar order. Drives the count and the list. */
	blockedSessions: Session[];
	theme: Theme;
	onClose: () => void;
}

/** Result of the last re-probe, or what is happening to it right now. */
type VerifyPhase = 'idle' | 'checking' | 'authenticated' | 'logged-out' | 'unknown';

export function AuthRecoveryModal({
	identity,
	blockedSessions,
	theme,
	onClose,
}: AuthRecoveryModalProps) {
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);

	// Bumped by "Re-run login command": a new run id is a new PTY stream and a
	// fresh terminal, which is what a user who aborted the browser flow needs.
	const [runId, setRunId] = useState(() => generateId());
	const [verifyPhase, setVerifyPhase] = useState<VerifyPhase>('idle');
	const [commandRevealed, setCommandRevealed] = useState(false);
	/** Command line as main actually spawned it; see the login effect below. */
	const [spawnedCommandLine, setSpawnedCommandLine] = useState<string | null>(null);
	/** Why the login could not start, from main. Null while it is running fine. */
	const [spawnError, setSpawnError] = useState<string | null>(null);
	/** Sign-in URL scraped from the login's output, once it prints one. */
	const [loginUrl, setLoginUrl] = useState<string | null>(null);
	/** The remote's own name, from main. The renderer only has its id. */
	const [remoteLabel, setRemoteLabel] = useState<string | null>(null);
	/** True once a remote login has gone quiet long enough to offer the manual path. */
	const [urlWaitExpired, setUrlWaitExpired] = useState(false);
	/**
	 * Latest `handleVerify`, for the PTY-exit listener below. A ref rather than a
	 * dependency: putting the callback in the login effect's deps would kill and
	 * re-spawn the login every time the verify phase changed.
	 */
	const verifyRef = useRef<() => Promise<void>>(async () => {});
	/** True while a probe is in flight, so exit and the button cannot both run one. */
	const verifyingRef = useRef(false);

	// Only decides WHICH surface to render (terminal vs guidance) and what note to
	// show. The command that actually runs is resolved in main, which knows the
	// account's env and the email from its last good snapshot.
	const loginCommand = useMemo(() => resolveLoginCommand(identity), [identity]);
	const canLogin = loginCommand !== null;
	const localCommandLine = loginCommand
		? [loginCommand.command, ...loginCommand.args].join(' ')
		: undefined;
	const commandLine = spawnedCommandLine ?? localCommandLine;
	const runSessionId = useMemo(
		() => buildLoginRunSessionId(identity.key, runId),
		[identity.key, runId]
	);

	// Which machine owns this credential. Read from the identity rather than from
	// the spawn result, so the copy is right from the first frame instead of
	// changing under the user once main answers.
	const remoteId = useMemo(() => sshRemoteIdFromHost(identity.host), [identity.host]);
	const isRemote = remoteId !== null;
	const hostLabel = remoteLabel ?? remoteId;

	/**
	 * Own the login PTY for the life of this run id.
	 *
	 * Start on mount and on every "Re-run"; kill on unmount and before each
	 * re-run, so a closed modal cannot leave a live PTY (and a half-finished OAuth
	 * flow) behind. App quit is covered by the ProcessManager's `killAll()`, since
	 * the login is a normal managed process.
	 *
	 * `canLogin` rather than `loginCommand` in the deps on purpose: the memo
	 * returns a fresh object whenever the identity object changes, and re-running
	 * this effect would kill and re-spawn a login the user is halfway through.
	 */
	useEffect(() => {
		if (!canLogin) return;
		const api = window.maestro?.providerAuth;
		if (!api) return;

		let cancelled = false;
		setSpawnError(null);
		setSpawnedCommandLine(null);
		// A re-run is a new flow: the previous run's URL is dead (its state
		// parameter went with the killed PTY), so offering it would send the user
		// through a sign-in that lands nowhere.
		setLoginUrl(null);
		setUrlWaitExpired(false);

		// A CLI that exits on its own is the earliest reliable "done", so check
		// right then instead of waiting for the button. Subscribed inside this
		// effect deliberately: the cleanup unsubscribes BEFORE killing the PTY, so
		// Maestro's own kill (modal closed, command re-run) cannot arrive here
		// looking like a finished login.
		const unsubscribeExit = window.maestro?.process?.onExit?.((exitedSessionId: string) => {
			if (exitedSessionId !== runSessionId) return;
			void verifyRef.current();
		});

		void api
			.startLogin({ identityKey: identity.key, runSessionId })
			.then((result) => {
				// The modal closed (or re-ran) while the spawn was in flight. Kill what
				// we just started rather than leaking it - the cleanup below already ran
				// and found nothing to stop.
				if (cancelled) {
					void api.stopLogin(runSessionId);
					return;
				}
				if (!result?.started) {
					setSpawnError(result?.error ?? 'The login command could not be started.');
					return;
				}
				if (result.commandLine) setSpawnedCommandLine(result.commandLine);
				if (result.remoteLabel) setRemoteLabel(result.remoteLabel);
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				logger.warn('Failed to start the login command', LOG_CONTEXT, {
					identityKey: identity.key,
					error: error instanceof Error ? error.message : String(error),
				});
				setSpawnError('The login command could not be started.');
			});

		return () => {
			cancelled = true;
			unsubscribeExit?.();
			void api.stopLogin(runSessionId);
		};
	}, [identity.key, runSessionId, canLogin]);

	/**
	 * Watch the login's own output for the sign-in URL.
	 *
	 * A remote login prints a URL the FAR machine cannot open, so reading it off
	 * the stream is what turns a hung terminal into a link the user can click on
	 * the machine that has the browser. The same tap runs for a local login: when
	 * `$BROWSER` fails to launch, the printed URL is the whole flow, and it is
	 * cheaper to always offer it than to detect that failure.
	 *
	 * Reads the same `process.onData` channel XTerminal renders from, so this
	 * cannot consume output the terminal would otherwise show.
	 */
	useEffect(() => {
		if (!canLogin) return;
		const subscribe = window.maestro?.process?.onData;
		if (!subscribe) return;

		// A URL can straddle two PTY chunks, so match against a rolling tail rather
		// than one chunk at a time. Bounded: the terminal owns the real scrollback.
		let buffer = '';
		return subscribe((sid: string, data: string) => {
			if (sid !== runSessionId) return;
			buffer = (buffer + data).slice(-URL_SCAN_BUFFER_CHARS);
			const url = extractLoginUrl(buffer);
			if (url) setLoginUrl(url);
		});
	}, [runSessionId, canLogin]);

	/**
	 * A remote login that has printed no URL is the case the user cannot solve by
	 * staring at it: the remote may have no browser at all, and the CLI can sit
	 * there forever. Wait a while, then say so and hand over the command.
	 */
	useEffect(() => {
		if (!canLogin || !isRemote || loginUrl) return;
		const timer = setTimeout(() => setUrlWaitExpired(true), REMOTE_URL_WAIT_MS);
		return () => clearTimeout(timer);
	}, [canLogin, isRemote, loginUrl, runSessionId]);

	// One handler for both exits, so the ESC pill cannot drift from the Escape
	// key. `<Modal>` registers the layer with this same function.
	const handleClose = useCallback(() => {
		onClose();
	}, [onClose]);

	const handleRerun = useCallback(() => {
		setVerifyPhase('idle');
		setRunId(generateId());
	}, []);

	/**
	 * Re-probe this credential and act on the verdict.
	 *
	 * Runs on the button AND on PTY exit: some CLIs keep running after the browser
	 * step, so process exit alone is not a reliable "done", and a user staring at a
	 * finished flow should not have to press anything either.
	 *
	 * Success is the service's job (rewrite the snapshot, clear every agent's auth
	 * error, flash) and ends with this modal closed. Failure deliberately leaves it
	 * open with the terminal scrollback intact: closing on failure hides the
	 * evidence the user needs to read.
	 */
	const handleVerify = useCallback(async () => {
		// Exit and the button can both fire within a second of each other; two
		// concurrent probes would spawn twice and race over the phase.
		if (verifyingRef.current) return;
		verifyingRef.current = true;
		setVerifyPhase('checking');
		try {
			const outcome = await verifyAuthRecovery(identity.key);
			// Set the phase before closing, so a parent that keeps this mounted for a
			// beat shows the confirmation rather than a stuck "Checking...".
			setVerifyPhase(outcome.status);
			if (outcome.status === 'authenticated') handleClose();
		} catch (error) {
			// `verifyAuthRecovery` is documented as never throwing, so this is the
			// guard against that promise being broken. Without it the phase stays on
			// 'checking' forever, which leaves the button disabled and the user with
			// no way forward but closing and reopening the modal.
			logger.warn('Verifying the login failed', LOG_CONTEXT, {
				identityKey: identity.key,
				error: error instanceof Error ? error.message : String(error),
			});
			setVerifyPhase('unknown');
		} finally {
			verifyingRef.current = false;
		}
	}, [identity.key, handleClose]);

	// Keep the exit listener pointed at the current callback without making it a
	// dependency of the login effect (which would re-spawn the login).
	useEffect(() => {
		verifyRef.current = handleVerify;
	}, [handleVerify]);

	/**
	 * Copy one value and confirm it, or say plainly that it did not copy.
	 *
	 * A denied clipboard permission rejects, and the old silent handler left the
	 * user watching for a flash that was never coming - with the login command
	 * still un-copied and nothing on screen admitting it.
	 */
	const copyWithFlash = useCallback((value: string, what: string) => {
		void navigator.clipboard?.writeText(value).then(
			() => flashCopiedToClipboard(value),
			(error: unknown) => {
				logger.warn('Clipboard write failed', LOG_CONTEXT, {
					what,
					error: error instanceof Error ? error.message : String(error),
				});
				notifyCenterFlash({ color: 'orange', message: `Could not copy the ${what}` });
			}
		);
	}, []);

	const handleCopyCommand = useCallback(() => {
		if (!commandLine) return;
		copyWithFlash(commandLine, 'command');
	}, [commandLine, copyWithFlash]);

	const handleCopyUrl = useCallback(() => {
		if (!loginUrl) return;
		copyWithFlash(loginUrl, 'sign-in link');
	}, [loginUrl, copyWithFlash]);

	const providerName = getAgentDisplayName(identity.provider);
	const blockedCount = blockedSessions.length;
	const blockedSummary =
		blockedCount === 0
			? 'No agents are using this account right now'
			: blockedCount === 1
				? `Unblocks 1 agent: ${blockedSessions[0].name}`
				: `Unblocks ${blockedCount} agents`;

	const header = (
		<div
			className="p-4 border-b flex items-start justify-between gap-3 shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-start gap-2 min-w-0">
				<KeyRound className="w-5 h-5 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
				<div className="min-w-0">
					<h2 className="text-sm font-bold truncate" style={{ color: theme.colors.textMain }}>
						Sign in to {providerName} ({identity.label})
					</h2>
					<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						{describeCredentialKind(identity.kind)} · {blockedSummary}
					</p>
				</div>
			</div>
			<EscCloseButton theme={theme} onClose={handleClose} testId="auth-recovery-esc" />
		</div>
	);

	const remedy = loginCommand ? null : describeCredentialRemedy(identity);

	const footer = (
		<>
			<button
				type="button"
				onClick={() => setCommandRevealed((shown) => !shown)}
				className="mr-auto text-xs underline hover:opacity-80 transition-opacity"
				style={{ color: theme.colors.accent }}
				data-testid="auth-recovery-reveal-command"
			>
				{commandRevealed ? 'Hide command' : 'Show command'}
			</button>
			{loginCommand && (
				<button
					type="button"
					onClick={handleRerun}
					className="px-4 py-2 rounded border hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					data-testid="auth-recovery-rerun"
				>
					<RefreshCw className="w-3.5 h-3.5" />
					Re-run login command
				</button>
			)}
			<button
				type="button"
				onClick={() => void handleVerify()}
				disabled={verifyPhase === 'checking'}
				className="px-4 py-2 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
				style={{
					backgroundColor: theme.colors.accent,
					color: theme.colors.accentForeground,
				}}
				data-testid="auth-recovery-verify"
			>
				{verifyPhase === 'checking' ? 'Checking…' : 'I finished logging in'}
			</button>
		</>
	);

	return (
		<Modal
			theme={theme}
			title={`Sign in to ${providerName}`}
			priority={MODAL_PRIORITIES.AUTH_RECOVERY}
			onClose={handleClose}
			customHeader={header}
			footer={footer}
			width={760}
			resizeKey="auth-recovery"
			defaultSize={{ width: 760, height: 520 }}
			minSize={{ width: 520, height: 420 }}
			contentClassName="p-4 flex flex-col gap-3 flex-1 min-h-0 overflow-hidden"
			testId="auth-recovery-modal"
		>
			{loginCommand ? (
				<>
					{/* Which machine, said plainly. A user who thinks this is signing in
					    locally will look for the credential in the wrong place, and will
					    not understand why no browser opened by itself. */}
					{isRemote && (
						<p
							className="text-xs"
							style={{ color: theme.colors.textDim }}
							data-testid="auth-recovery-remote-note"
						>
							This account lives on {hostLabel}, so Maestro runs the login there over SSH. The
							browser step happens on this machine; the new credential is written on {hostLabel},
							not here.
						</p>
					)}
					{loginCommand.note && (
						<p className="text-xs" style={{ color: theme.colors.textDim }}>
							{loginCommand.note}
						</p>
					)}
					{/* A terminal that stayed black because nothing could be spawned is
					    indistinguishable from one that is thinking, so say what happened. */}
					{spawnError && (
						<p
							className="text-xs"
							style={{ color: theme.colors.warning }}
							data-testid="auth-recovery-spawn-error"
						>
							{spawnError}
						</p>
					)}
					{/* The terminal is sized by the modal and reflows with it: an
					    absolutely-positioned child of a flex-1 box, the same shape
					    TerminalView mounts its tabs in. */}
					<div
						className="relative flex-1 min-h-0 rounded border overflow-hidden"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						data-testid="auth-recovery-terminal"
					>
						<div className="absolute inset-0">
							{/* Keyed by the run id so "Re-run" unmounts the old terminal
							    (disposing its xterm instance and detaching its listeners)
							    rather than reusing it under a new process. */}
							<XTerminal
								key={runSessionId}
								sessionId={runSessionId}
								theme={theme}
								fontFamily={fontFamily}
								fontSize={Math.round(fontSize * 0.85)}
							/>
						</div>
					</div>
					{/* The link the flow is waiting on, out of the terminal and into
					    something clickable. Opened through `openUrl` so it honors the
					    user's system-vs-Maestro browser setting like every other link. */}
					{loginUrl && (
						<div
							className="rounded border p-3 text-xs flex items-center gap-2"
							style={{ borderColor: theme.colors.accent, backgroundColor: theme.colors.bgMain }}
							data-testid="auth-recovery-login-url"
						>
							<ExternalLink
								className="w-3.5 h-3.5 shrink-0"
								style={{ color: theme.colors.accent }}
							/>
							<div className="min-w-0">
								<p style={{ color: theme.colors.textMain }}>
									{isRemote
										? `${hostLabel} cannot open a browser. Open its sign-in page here:`
										: 'Sign-in page, if your browser did not open on its own:'}
								</p>
								<code className="block truncate" style={{ color: theme.colors.textDim }}>
									{loginUrl}
								</code>
							</div>
							<button
								type="button"
								onClick={(e) => openUrl(loginUrl, { ctrlKey: e.metaKey || e.ctrlKey })}
								className="ml-auto shrink-0 underline hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.accent }}
								data-testid="auth-recovery-open-url"
							>
								Open
							</button>
							<button
								type="button"
								onClick={handleCopyUrl}
								className="shrink-0 underline hover:opacity-80 transition-opacity"
								style={{ color: theme.colors.accent }}
								data-testid="auth-recovery-copy-url"
							>
								Copy
							</button>
						</div>
					)}
					{/* A remote with no browser and no printed URL leaves the CLI waiting
					    on something that will never happen. Say that, and hand over the
					    command so the user can finish the flow on the remote itself. */}
					{isRemote && urlWaitExpired && !loginUrl && !spawnError && (
						<div
							className="rounded border p-3 text-xs"
							style={{
								borderColor: theme.colors.warning,
								backgroundColor: theme.colors.warning + '10',
							}}
							data-testid="auth-recovery-remote-no-url"
						>
							<p style={{ color: theme.colors.warning }}>
								No sign-in link has come back from {hostLabel} yet.
							</p>
							<p className="mt-1" style={{ color: theme.colors.textDim }}>
								If that machine has no browser and the CLI is waiting on one, sign in on {hostLabel}
								itself: open a shell there and run the command below, then come back and press "I
								finished logging in".
							</p>
							{commandLine && (
								<div className="flex items-center gap-2 mt-2">
									<TerminalIcon
										className="w-3.5 h-3.5 shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<code className="truncate" style={{ color: theme.colors.textMain }}>
										{commandLine}
									</code>
									<button
										type="button"
										onClick={handleCopyCommand}
										className="ml-auto underline hover:opacity-80 transition-opacity"
										style={{ color: theme.colors.accent }}
										data-testid="auth-recovery-remote-copy-command"
									>
										Copy
									</button>
								</div>
							)}
						</div>
					)}
				</>
			) : (
				remedy && (
					<div
						className="flex items-start gap-2 p-3 rounded border"
						style={{
							borderColor: theme.colors.warning,
							backgroundColor: theme.colors.warning + '10',
						}}
						data-testid="auth-recovery-guidance"
					>
						<ShieldAlert
							className="w-4 h-4 mt-0.5 shrink-0"
							style={{ color: theme.colors.warning }}
						/>
						<div className="text-sm min-w-0">
							<p style={{ color: theme.colors.warning }}>{remedy.title}</p>
							<p className="mt-1" style={{ color: theme.colors.textDim }}>
								{remedy.body}
							</p>
						</div>
					</div>
				)
			)}

			{commandRevealed && (
				<div
					className="rounded border p-3 text-xs"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					data-testid="auth-recovery-command"
				>
					{commandLine ? (
						<>
							<div className="flex items-center gap-2">
								<TerminalIcon
									className="w-3.5 h-3.5 shrink-0"
									style={{ color: theme.colors.textDim }}
								/>
								<code className="truncate" style={{ color: theme.colors.textMain }}>
									{commandLine}
								</code>
								<button
									type="button"
									onClick={handleCopyCommand}
									className="ml-auto underline hover:opacity-80 transition-opacity"
									style={{ color: theme.colors.accent }}
								>
									Copy
								</button>
							</div>
							{identity.configDir && (
								<p className="mt-2" style={{ color: theme.colors.textDim }}>
									Maestro runs it against {identity.configDir}
									{isRemote ? ` on ${hostLabel}` : ''}. In your own terminal, point{' '}
									{identity.envVarName ?? 'the CLI'} at that directory first or you will sign in to
									the default account.
								</p>
							)}
						</>
					) : (
						<span style={{ color: theme.colors.textDim }}>
							There is no login command for this credential.
						</span>
					)}
				</div>
			)}

			{verifyPhase !== 'idle' && verifyPhase !== 'checking' && (
				<div
					className="rounded border p-3 text-xs"
					style={{
						borderColor:
							verifyPhase === 'authenticated' ? theme.colors.success : theme.colors.warning,
						backgroundColor:
							(verifyPhase === 'authenticated' ? theme.colors.success : theme.colors.warning) +
							'10',
						color: theme.colors.textDim,
					}}
					data-testid="auth-recovery-status"
					data-verify-phase={verifyPhase}
				>
					{verifyPhase === 'authenticated' && `${identity.label} is signed in.`}
					{verifyPhase === 'logged-out' &&
						`${identity.label} still reports no active login. Read the terminal above for what the CLI said, then re-run the command.`}
					{verifyPhase === 'unknown' &&
						`Could not confirm the login for ${identity.label}. Nothing is claimed either way - finish the flow in the terminal and check again.`}
				</div>
			)}
		</Modal>
	);
}

export default AuthRecoveryModal;
