/**
 * GitHubLoginModal - sign the GitHub CLI in without leaving Send Feedback.
 *
 * Feedback is filed through `gh`, so a missing or expired gh login used to end
 * the flow at "run gh auth login in your terminal". This runs that login in an
 * embedded terminal (the same `LoginTerminal` the provider re-auth dialog uses)
 * with the gh binary feedback itself resolves, and hands control back the
 * moment gh reports signed in.
 *
 * The command is typed with an exit suffix, so the login shell ends when gh
 * does and carries its exit code: 0 re-checks gh (skipping the cached verdict)
 * and continues on its own. "Check again" covers a login finished somewhere
 * else.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Github, RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Spinner } from './ui/Spinner';
import { AccountPill, ghAccountLabel } from './ui/AccountPill';
import {
	LoginTerminal,
	loginPtySessionId,
	resolveLoginShell,
	type LoginTerminalStatus,
} from './LoginTerminal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useSettingsStore } from '../stores/settingsStore';
import { isWindowsPlatform } from '../utils/platformUtils';
import {
	exitWithCommandStatus,
	formatAgentLoginCommand,
	loginShellSyntaxFor,
} from '../../shared/agentMetadata';
import type { FeedbackGhLoginCommand } from '../../shared/feedback';
import type { Theme } from '../types';

export interface GitHubLoginModalProps {
	theme: Theme;
	/** Why the login was offered, shown above the terminal. */
	reason?: string;
	/**
	 * The account gh is signed in as now, when known. Named so a user who is on
	 * the wrong account sees it before signing in again, rather than after.
	 */
	account?: { host: string; login: string };
	onClose: () => void;
	/** gh now reports signed in. The caller continues where it stopped. */
	onSignedIn: () => void;
}

type Phase =
	| { kind: 'loading' }
	| { kind: 'running' }
	| { kind: 'verifying' }
	| { kind: 'not-signed-in'; message: string }
	| { kind: 'error'; message: string };

export function GitHubLoginModal({
	theme,
	reason,
	account,
	onClose,
	onSignedIn,
}: GitHubLoginModalProps) {
	const defaultShell = useSettingsStore((s) => s.defaultShell);
	const shellArgs = useSettingsStore((s) => s.shellArgs);
	const shellEnvVars = useSettingsStore((s) => s.shellEnvVars);

	const [login, setLogin] = useState<FeedbackGhLoginCommand | null>(null);
	const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
	// A new key starts a new shell, which is all "Try again" needs.
	const [ptySessionId, setPtySessionId] = useState(() => loginPtySessionId('gh-login'));

	useEffect(() => {
		let cancelled = false;
		window.maestro.feedback
			.getGhLoginCommand()
			.then((command) => {
				if (cancelled) return;
				setLogin(command);
				setPhase({ kind: 'running' });
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				setPhase({
					kind: 'error',
					message: error instanceof Error ? error.message : 'Could not find the GitHub CLI.',
				});
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// gh runs as a native process, so the login shell must never be WSL.
	const loginShell = useMemo(() => resolveLoginShell(defaultShell, false), [defaultShell]);

	const commandLine = useMemo(() => {
		if (!login) return null;
		const syntax = loginShellSyntaxFor(loginShell ?? '', isWindowsPlatform());
		return exitWithCommandStatus(
			formatAgentLoginCommand({ binary: login.command, args: login.args.join(' ') }, syntax),
			syntax
		);
	}, [login, loginShell]);

	/** Ask gh again, skipping the cached verdict, and continue if it is signed in. */
	const verify = useCallback(async () => {
		setPhase({ kind: 'verifying' });
		try {
			const result = await window.maestro.feedback.checkGhAuth({ fresh: true });
			if (result.authenticated) {
				onSignedIn();
				return;
			}
			setPhase({
				kind: 'not-signed-in',
				message: result.message || 'GitHub CLI is still not signed in.',
			});
		} catch (error) {
			setPhase({
				kind: 'error',
				message: error instanceof Error ? error.message : 'Could not check the GitHub CLI.',
			});
		}
	}, [onSignedIn]);

	const handleExit = useCallback(
		(code: number) => {
			if (code === 0) {
				void verify();
				return;
			}
			setPhase({
				kind: 'not-signed-in',
				message: `The GitHub login ended without signing in (gh exited with code ${code}).`,
			});
		},
		[verify]
	);

	const handleStatusChange = useCallback((status: LoginTerminalStatus, error: string | null) => {
		if (status === 'failed') {
			setPhase({ kind: 'error', message: error ?? 'The login terminal failed to start.' });
		}
	}, []);

	const handleRetry = useCallback(() => {
		setPtySessionId(loginPtySessionId('gh-login'));
		setPhase({ kind: 'running' });
	}, []);

	const statusLine =
		phase.kind === 'loading'
			? 'Finding the GitHub CLI...'
			: phase.kind === 'running'
				? 'Follow the prompts above. Feedback continues as soon as gh is signed in.'
				: phase.kind === 'verifying'
					? 'Checking the GitHub CLI...'
					: phase.message;
	const statusColor =
		phase.kind === 'error'
			? theme.colors.error
			: phase.kind === 'not-signed-in'
				? theme.colors.warning
				: theme.colors.textDim;
	const loginEnded = phase.kind === 'not-signed-in' || phase.kind === 'error';

	return (
		<Modal
			theme={theme}
			title="Log in to GitHub"
			priority={MODAL_PRIORITIES.GH_LOGIN}
			onClose={onClose}
			width={900}
			maxHeight="90vh"
			resizeKey="modal-gh-login"
			defaultSize={{ width: 900, height: 640 }}
			minSize={{ width: 520, height: 400 }}
			zIndex={10002}
			portal
			headerIcon={<Github className="w-5 h-5" style={{ color: theme.colors.accent }} />}
			contentClassName="flex-1 min-h-0 flex flex-col"
			testId="gh-login-modal"
			footer={
				<div className="flex items-center gap-3 w-full">
					<div
						className="mr-auto text-xs min-w-0 truncate select-text flex items-center gap-2"
						style={{ color: statusColor }}
						title={statusLine}
						data-testid="gh-login-status"
					>
						{phase.kind === 'verifying' && <Spinner size={12} />}
						<span className="truncate">{statusLine}</span>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						Cancel
					</button>
					{loginEnded && login && (
						<button
							type="button"
							onClick={handleRetry}
							className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							data-testid="gh-login-retry"
						>
							Try Again
						</button>
					)}
					<button
						type="button"
						onClick={() => void verify()}
						disabled={phase.kind === 'verifying'}
						className="inline-flex items-center gap-1.5 px-4 py-2 rounded transition-colors disabled:opacity-50"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						data-testid="gh-login-check"
					>
						<RefreshCw className="w-3.5 h-3.5" />
						Check Again
					</button>
				</div>
			}
		>
			<div className="flex flex-col gap-3 flex-1 min-h-0 p-4">
				<p className="text-sm leading-relaxed" style={{ color: theme.colors.textMain }}>
					Feedback is filed as a GitHub issue through the GitHub CLI. Sign it in below: gh shows a
					one-time code, opens github.com in your browser, and finishes here once you approve it.
					Signed in somewhere else? Use Check Again.
				</p>
				{account && (
					<div className="flex items-center gap-2 flex-wrap shrink-0">
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							Currently signed in as
						</span>
						<AccountPill theme={theme} label={ghAccountLabel(account)} testId="gh-login-account" />
					</div>
				)}
				{reason && (
					<p className="text-xs select-text" style={{ color: theme.colors.textDim }}>
						{reason}
					</p>
				)}

				{commandLine && login && (
					<div
						className="flex items-center gap-2 text-xs font-mono px-3 py-2 rounded border select-text shrink-0"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<TerminalIcon className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
						<span className="truncate">{login.display}</span>
					</div>
				)}

				{commandLine ? (
					<LoginTerminal
						theme={theme}
						ptySessionId={ptySessionId}
						commandLine={commandLine}
						spawn={{ shell: loginShell, shellArgs, shellEnvVars }}
						onStatusChange={handleStatusChange}
						onExit={handleExit}
						testIdPrefix="gh-login"
					/>
				) : phase.kind === 'error' ? null : (
					<div className="flex-1 flex items-center justify-center">
						<Spinner size={24} color={theme.colors.accent} />
					</div>
				)}
			</div>
		</Modal>
	);
}

export default GitHubLoginModal;
