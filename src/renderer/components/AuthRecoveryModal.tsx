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

import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, RefreshCw, ShieldAlert, Terminal as TerminalIcon } from 'lucide-react';
import { Modal } from './ui/Modal';
import { EscCloseButton } from './ui/EscCloseButton';
import { XTerminal } from './XTerminal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { useProviderAuthStore } from '../stores/providerAuthStore';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { buildLoginRunSessionId, resolveLoginCommand } from '../../shared/providerAuth';
import type { CredentialIdentity, CredentialKind } from '../../shared/providerAuth';
import { generateId } from '../utils/ids';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { logger } from '../utils/logger';
import type { Session, Theme } from '../types';

const LOG_CONTEXT = '[AuthRecovery]';

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
	const refreshIdentity = useProviderAuthStore((s) => s.refreshIdentity);

	// Bumped by "Re-run login command": a new run id is a new PTY stream and a
	// fresh terminal, which is what a user who aborted the browser flow needs.
	const [runId, setRunId] = useState(() => generateId());
	const [verifyPhase, setVerifyPhase] = useState<VerifyPhase>('idle');
	const [commandRevealed, setCommandRevealed] = useState(false);
	/** Command line as main actually spawned it; see the login effect below. */
	const [spawnedCommandLine, setSpawnedCommandLine] = useState<string | null>(null);
	/** Why the login could not start, from main. Null while it is running fine. */
	const [spawnError, setSpawnError] = useState<string | null>(null);

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
			void api.stopLogin(runSessionId);
		};
	}, [identity.key, runSessionId, canLogin]);

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
	 * Ask main to re-probe this credential and report what it found.
	 *
	 * The button exists because some CLIs keep running after the browser step, so
	 * process exit alone is not a reliable "done". A failed check deliberately
	 * leaves the modal open with the terminal scrollback intact: closing on
	 * failure hides the evidence the user needs to read.
	 */
	const handleVerify = useCallback(async () => {
		setVerifyPhase('checking');
		try {
			await refreshIdentity(identity.key);
		} catch (error) {
			logger.warn('Re-probe after login failed', LOG_CONTEXT, {
				identityKey: identity.key,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const status = useProviderAuthStore.getState().snapshots[identity.key]?.status;
		// TODO(Phase 04, "success detection"): on `authenticated`, clear the auth
		// error for EVERY session on this identity, flash green, and close.
		setVerifyPhase(
			status === 'authenticated'
				? 'authenticated'
				: status === 'logged-out'
					? 'logged-out'
					: 'unknown'
		);
	}, [identity.key, refreshIdentity]);

	const handleCopyCommand = useCallback(() => {
		if (!commandLine) return;
		void navigator.clipboard?.writeText(commandLine).then(
			() => flashCopiedToClipboard(commandLine),
			() => {}
		);
	}, [commandLine]);

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
									Maestro runs it against {identity.configDir}. In your own terminal, point{' '}
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
