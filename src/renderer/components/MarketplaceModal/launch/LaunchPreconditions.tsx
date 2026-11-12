/**
 * LaunchPreconditions - what a playbook needs before it can launch.
 *
 * Draws the playbook's `preconditions` block: the plain-language `requires` list, the reason the
 * playbook cannot launch on this machine at all (its platform or Maestro version), the
 * `maestro-cli` row, and the `confirm` checkbox a security-sensitive playbook asks for.
 *
 * The `maestro-cli` row follows the chosen agent (see "maestro-cli inside playbooks" in the
 * Playbook Launch README). Tasks of some playbooks call `maestro-cli` from the agent's shell, so:
 *
 * - `required` and not installed: a warning with an **Install maestro-cli** button. The caller
 *   keeps Launch off until the install succeeds (`LaunchGate.available`).
 * - `optional` and not installed: an info row that names what is skipped, the same button, and
 *   Launch stays on.
 * - an agent on an SSH remote: the `maestro-cli` on this machine cannot reach it, so there is no
 *   button. `required` blocks Launch, `optional` adds the skipped-steps note.
 *
 * The strings that explain a block or a skip come from `isLaunchAvailable()` through
 * `evaluateLaunchGate()`, so this file never words a rule the gate does not own.
 */

import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PlaybookLaunchSpec } from '../../../../shared/marketplace-types';
import type { MaestroCliState } from '../../../hooks/utils/useMaestroCliState';
import type { Theme } from '../../../types';
import { HeaderActionButton } from '../../ui/HeaderActionButton';
import { Spinner } from '../../ui/Spinner';
import { LaunchCheckbox } from './LaunchCheckbox';
import type { LaunchGate } from './launchAgents';

/** Said after an install that changed the PATH. */
const RESTART_NOTE =
	'Only terminal windows opened from now on see the change. Agents Maestro starts already get the updated PATH.';

type NoticeTone = 'warning' | 'info' | 'success';

interface NoticeRowProps {
	theme: Theme;
	tone: NoticeTone;
	testId: string;
	children: ReactNode;
	/** A control to the right of the text. */
	action?: ReactNode;
}

/** One bordered row: an icon in the tone's color, the text, and an optional control. */
function NoticeRow({ theme, tone, testId, children, action }: NoticeRowProps) {
	const color =
		tone === 'warning'
			? theme.colors.warning
			: tone === 'success'
				? theme.colors.success
				: theme.colors.textDim;
	const Icon = tone === 'warning' ? AlertTriangle : tone === 'success' ? CheckCircle2 : Info;
	return (
		<div
			role={tone === 'warning' ? 'alert' : 'status'}
			className="flex items-start gap-2 rounded border p-2.5 text-xs"
			style={{ borderColor: color, backgroundColor: theme.colors.bgMain }}
			data-testid={testId}
		>
			<Icon className="w-4 h-4 shrink-0 mt-px" style={{ color }} aria-hidden="true" />
			<div
				className="flex-1 min-w-0 space-y-1 select-text"
				style={{ color: theme.colors.textMain }}
			>
				{children}
			</div>
			{action}
		</div>
	);
}

interface MaestroCliRowProps {
	theme: Theme;
	mode: NonNullable<NonNullable<PlaybookLaunchSpec['preconditions']>['maestroCli']>;
	gate: LaunchGate;
	cli: MaestroCliState;
	/** The chosen agent works on an SSH remote. */
	remote: boolean;
	disabled: boolean;
}

function MaestroCliRow({ theme, mode, gate, cli, remote, disabled }: MaestroCliRowProps) {
	if (remote) {
		// No install can help: the CLI that matters would have to be on the remote.
		const text = gate.cliReason ?? gate.notes.join(' ');
		return (
			<NoticeRow
				theme={theme}
				tone={mode === 'required' ? 'warning' : 'info'}
				testId="launch-maestro-cli-row"
			>
				<p>{text}</p>
			</NoticeRow>
		);
	}

	// Not read yet: neither a status nor a failure to read one.
	if (cli.status === null && cli.statusError === null) {
		return (
			<NoticeRow theme={theme} tone="info" testId="launch-maestro-cli-row">
				<p className="flex items-center gap-2">
					<Spinner size={12} color={theme.colors.textDim} />
					Checking whether maestro-cli is installed...
				</p>
			</NoticeRow>
		);
	}

	if (cli.status?.installed) {
		return (
			<NoticeRow theme={theme} tone="success" testId="launch-maestro-cli-row">
				<p>maestro-cli is installed.</p>
				{cli.restartRequired && <p style={{ color: theme.colors.textDim }}>{RESTART_NOTE}</p>}
				{cli.installMessage && !cli.installMessage.ok && (
					<p style={{ color: theme.colors.warning }}>{cli.installMessage.text}</p>
				)}
			</NoticeRow>
		);
	}

	return (
		<NoticeRow
			theme={theme}
			tone={mode === 'required' ? 'warning' : 'info'}
			testId="launch-maestro-cli-row"
			action={
				<HeaderActionButton
					theme={theme}
					onClick={() => void cli.installOrUpdate()}
					disabled={disabled || cli.installing}
					testId="launch-install-maestro-cli"
				>
					{cli.installing ? 'Installing...' : 'Install maestro-cli'}
				</HeaderActionButton>
			}
		>
			<p>{gate.cliReason ?? gate.notes.join(' ')}</p>
			{cli.statusError && <p style={{ color: theme.colors.error }}>{cli.statusError}</p>}
			{cli.installMessage && !cli.installMessage.ok && (
				<p style={{ color: theme.colors.warning }}>{cli.installMessage.text}</p>
			)}
		</NoticeRow>
	);
}

export interface LaunchPreconditionsProps {
	theme: Theme;
	preconditions: PlaybookLaunchSpec['preconditions'];
	gate: LaunchGate;
	/** The install state, from `useMaestroCliState`. */
	maestroCli: MaestroCliState;
	/** The chosen agent works on an SSH remote. */
	remote: boolean;
	confirmed: boolean;
	onConfirmedChange: (confirmed: boolean) => void;
	disabled?: boolean;
}

/** Draws nothing when the playbook declares no preconditions and can launch here. */
export function LaunchPreconditions({
	theme,
	preconditions,
	gate,
	maestroCli,
	remote,
	confirmed,
	onConfirmedChange,
	disabled = false,
}: LaunchPreconditionsProps) {
	const requires = preconditions?.requires ?? [];
	const confirm = preconditions?.confirm;
	const mode = preconditions?.maestroCli;
	if (requires.length === 0 && !confirm && !mode && !gate.blockedReason) return null;

	return (
		<section className="space-y-3" data-testid="launch-preconditions">
			<h4
				className="text-xs font-bold uppercase opacity-70"
				style={{ color: theme.colors.textMain }}
			>
				Requirements
			</h4>
			{requires.length > 0 && (
				<ul
					className="list-disc pl-5 space-y-0.5 text-xs select-text"
					style={{ color: theme.colors.textMain }}
					data-testid="launch-requires"
				>
					{requires.map((need) => (
						<li key={need}>{need}</li>
					))}
				</ul>
			)}
			{gate.blockedReason && (
				<NoticeRow theme={theme} tone="warning" testId="launch-blocked-reason">
					<p>{gate.blockedReason}</p>
				</NoticeRow>
			)}
			{/* A playbook that cannot launch here at all has no use for the CLI row. */}
			{mode && !gate.blockedReason && (
				<MaestroCliRow
					theme={theme}
					mode={mode}
					gate={gate}
					cli={maestroCli}
					remote={remote}
					disabled={disabled}
				/>
			)}
			{confirm && (
				<LaunchCheckbox
					theme={theme}
					checked={confirmed}
					onChange={onConfirmedChange}
					label={confirm}
					disabled={disabled}
					testId="launch-confirm"
				/>
			)}
		</section>
	);
}
