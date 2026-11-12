import type { Theme } from '../../../types';
import { useSessionStore, selectSessionById } from '../../../stores/sessionStore';
import { useModalStore } from '../../../stores/modalStore';
import {
	useGitAgentActions,
	resolveGitCwd,
	resolveGitSshRemoteId,
} from '../../../hooks/git/useGitAgentActions';
import { gitService } from '../../../services/git';
import { notifyToast } from '../../../stores/notificationStore';
import { readableTextOn, transparentize } from '../../../../shared/colorContrast';

/** The five git directives, as the allowlist spells them. */
export const GIT_DIRECTIVE_NAMES = [
	'git-commit',
	'git-push',
	'git-stage',
	'git-create-branch',
	'git-create-pr',
] as const;

export type GitDirectiveName = (typeof GIT_DIRECTIVE_NAMES)[number];

const GIT_DIRECTIVE_NAME_SET: ReadonlySet<string> = new Set(GIT_DIRECTIVE_NAMES);

export function isGitDirectiveName(name: string): name is GitDirectiveName {
	return GIT_DIRECTIVE_NAME_SET.has(name);
}

/**
 * Which existing Maestro surface a click opens.
 *
 * `'none'` is a real outcome, not a failure: Maestro has no staging surface and
 * no git plumbing that stages without committing, so a `::git-stage` renders as
 * the command it suggests and nothing more. A button wired to nothing reads as
 * broken, and one wired to the NEAREST thing would commit when the agent asked
 * to stage.
 */
export type GitDirectiveSurface = 'push' | 'createPR' | 'commit' | 'none';

export interface GitDirectivePlan {
	/** What the control says, e.g. `Push to origin/feat-x`. */
	label: string;
	/**
	 * The exact command the click leads to, shown BEFORE anything runs. Null
	 * when the directive named no target and the command would be a fragment -
	 * half a command reads as a promise nothing can keep.
	 */
	command: string | null;
	surface: GitDirectiveSurface;
	/**
	 * Why there is nothing to press, when the directive asked for something
	 * Maestro's own surfaces cannot do. Rendered dim under the command.
	 *
	 * A `'none'` surface with no note is a directive that never had a click in it
	 * (a `::git-stage`); a note means the agent asked for a specific target and
	 * the honest answer is the command plus the reason, not a button that would
	 * do something else.
	 */
	note?: string;
}

/** `true` on the wire is the bare string, since attribute values are text. */
function isTrue(value: string | undefined): boolean {
	return value === 'true' || value === '1';
}

/**
 * Turn one git directive into what a reader is shown and what a click does.
 *
 * Pure and exported so the mapping is testable without a store, a session, or a
 * git repo - which matters because the thing worth proving about these controls
 * is that the label and the command agree with each other and with the surface
 * the click opens.
 *
 * `fallbackBranch` is the agent's live branch, used only where the directive
 * left the branch out. It is never allowed to CONTRADICT an attribute: the
 * agent named a branch for a reason, and quietly retargeting a push at whatever
 * happens to be checked out is the worst kind of wrong.
 *
 * Which is also why a surface here is only ever the one that does EXACTLY what
 * the command line says. Maestro's git surfaces take no target of their own -
 * the runner pushes the checked-out branch to its own upstream, and the branch
 * switcher switches without creating - so a directive naming something else gets
 * the command and a reason rather than a button. Printing `git push upstream
 * release` over a click that pushes whatever is checked out is the exact failure
 * the command line exists to prevent.
 */
export function describeGitDirective(
	name: GitDirectiveName,
	attributes: Record<string, string>,
	fallbackBranch?: string
): GitDirectivePlan {
	switch (name) {
		case 'git-push': {
			const remote = attributes.remote || 'origin';
			const branch = attributes.branch || fallbackBranch;
			// The runner takes no remote and no branch: it runs `git push` in this
			// repository, which pushes the CHECKED-OUT branch. So a named remote
			// other than origin, or a named branch that is not the live one, is a
			// target the click cannot reach - including when polling has not yet
			// told us what the live branch is, since unverified is not the same as
			// matching.
			const wrongRemote = Boolean(attributes.remote) && attributes.remote !== 'origin';
			const wrongBranch = Boolean(attributes.branch) && attributes.branch !== fallbackBranch;
			const note = wrongRemote
				? `Maestro pushes to the branch's own upstream, not to ${attributes.remote}.`
				: wrongBranch
					? fallbackBranch
						? `Maestro pushes the checked-out branch, and ${fallbackBranch} is checked out.`
						: 'Maestro pushes the checked-out branch, which has not been read yet.'
					: undefined;
			return {
				label: branch ? `Push to ${remote}/${branch}` : `Push to ${remote}`,
				command: `git push ${remote}${branch ? ` ${branch}` : ''}`,
				surface: note ? 'none' : 'push',
				...(note ? { note } : {}),
			};
		}
		case 'git-create-pr': {
			const draft = isTrue(attributes.isDraft) || isTrue(attributes.draft);
			const title = attributes.title;
			// The form owns the title and opens a ready PR, so neither `--title` nor
			// `--draft` reaches `gh` - printing them would claim two flags the click
			// does not pass. The agent's title rides the LABEL instead, where it
			// reads as the suggestion it is and stays in front of the user while
			// they fill the form in.
			return {
				label: `${draft ? 'Create draft pull request' : 'Create pull request'}${
					title ? `: ${title}` : ''
				}`,
				command: 'gh pr create',
				surface: 'createPR',
			};
		}
		case 'git-create-branch': {
			const branch = attributes.name || attributes.branch;
			// The branch switcher SWITCHES - it has no create path - so there is no
			// surface behind this directive. Offering the switcher would hand the
			// user a picker that cannot contain the branch they just asked for.
			return {
				label: branch ? `Create branch ${branch}` : 'Create a branch',
				command: branch ? `git checkout -b ${branch}` : null,
				surface: 'none',
				note: 'Maestro switches branches but does not create them.',
			};
		}
		case 'git-commit': {
			const message = attributes.message || attributes.m;
			return {
				label: 'Commit all changes',
				command: message ? `git commit -a -m "${message}"` : null,
				// Without a message there is nothing to commit WITH, and inventing
				// one would put words in the user's history.
				surface: message ? 'commit' : 'none',
			};
		}
		case 'git-stage': {
			const paths = attributes.paths || attributes.files || attributes.path;
			return {
				label: paths ? `Stage ${paths}` : 'Stage all changes',
				command: `git add ${paths || '.'}`,
				surface: 'none',
			};
		}
	}
}

/**
 * Report a commit the way the user asked for it.
 *
 * A clean tree is NOT a failure - `commitAll` resolves `{ success: true,
 * committed: false }` for it - so the three outcomes are told apart here rather
 * than collapsed into worked / did not work. Telling someone their commit
 * failed when there was simply nothing to commit sends them looking for a
 * problem that does not exist.
 */
function reportCommit(message: string) {
	return (result: {
		success: boolean;
		committed: boolean;
		commitHash?: string;
		error?: string;
	}) => {
		if (result.success && result.committed) {
			notifyToast({
				color: 'green',
				title: 'Committed',
				message: result.commitHash ? `${message} (${result.commitHash.slice(0, 7)})` : message,
			});
			return;
		}
		notifyToast({
			color: result.success ? 'yellow' : 'red',
			title: result.success ? 'Nothing to commit' : 'Commit failed',
			message: result.success
				? 'The working tree was already clean.'
				: result.error || 'git commit failed',
		});
	};
}

export interface GitActionCardProps {
	name: GitDirectiveName;
	attributes: Record<string, string>;
	/** Agent whose repository the directive is about. */
	sessionId: string;
	theme: Theme;
}

/**
 * The visible form of a git action directive (`::git-push`, `::git-commit`,
 * `::git-stage`, `::git-create-branch`, `::git-create-pr`).
 *
 * These are the only directives in the family that CHANGE something, and every
 * rule here follows from that:
 *
 * 1. **Rendering does nothing.** The card is drawn while a message streams in,
 *    re-drawn on every theme change, and drawn again in the History panel weeks
 *    later. A push that fired on render would push a repository the user was
 *    only reading about, so nothing outside an `onClick` touches git.
 * 2. **The command is on screen before the click.** The label is agent-authored
 *    prose; the line under it is the command itself, so a friendly label over a
 *    surprising command cannot hide it - the same rule the follow-up chip
 *    applies to its prompt.
 * 3. **The click opens Maestro's own surface.** `useGitAgentActions` is where a
 *    push and a PR already live, so a directive lands the user in the runner or
 *    the form they would have reached from the branch pill, with its own
 *    confirmation. A commit goes through the confirm dialog and
 *    `gitService.commitAll`.
 * 4. **A directive whose target the surface would drop has no button.** Staging,
 *    creating a branch, and pushing somewhere other than the checked-out branch
 *    all render as the command plus the reason (see `GitDirectivePlan.note`).
 *    Rule 2 is only worth anything if the command is what actually runs.
 */
export function GitActionCard({ name, attributes, sessionId, theme }: GitActionCardProps) {
	const session = useSessionStore(selectSessionById(sessionId));
	const git = useGitAgentActions(session);
	const plan = describeGitDirective(name, attributes, git.branch);

	// No repository to act on: the directive is still worth showing (it says
	// what the agent wanted to do) but there is nothing to press.
	const actionable = Boolean(session && git.isGitRepo) && plan.surface !== 'none';
	const running =
		(plan.surface === 'push' && git.pushRunning) || (plan.surface === 'createPR' && git.prRunning);

	const baseColor = theme.colors.accent;
	const background = transparentize(baseColor, theme.colors.bgMain, 0.1);
	const borderColor = transparentize(baseColor, theme.colors.bgMain, 0.35);
	const buttonText = readableTextOn(baseColor, [background, theme.colors.bgMain]);

	const run = () => {
		if (!session) return;
		switch (plan.surface) {
			case 'push':
				git.push();
				return;
			case 'createPR':
				git.createPR();
				return;
			case 'commit': {
				const message = attributes.message || attributes.m;
				// `surface` is only `'commit'` when a message was given, so this
				// cannot fire without one - the guard is what proves it here.
				if (!message) return;
				const cwd = resolveGitCwd(session);
				// One more look at the exact command, because a commit is the one
				// action here that opens no surface of its own to confirm in.
				useModalStore.getState().openModal('confirm', {
					message: `Run in ${cwd}:\n\n${plan.command}`,
					onConfirm: () => {
						void gitService
							.commitAll(cwd, message, resolveGitSshRemoteId(session))
							.then(reportCommit(message));
					},
				});
				return;
			}
			case 'none':
				return;
		}
	};

	return (
		// A `span` set to `display: block`: the directive is replaced inline, so
		// the card lives inside a paragraph where a `div` is invalid markup.
		<span
			data-testid="codex-git-action"
			data-git-directive={name}
			data-git-surface={plan.surface}
			style={{
				display: 'block',
				// `em` throughout so the card tracks the reading pane's font scale.
				margin: '0.4em 0',
				padding: '0.5em 0.7em',
				borderRadius: '0.4em',
				border: `1px solid ${borderColor}`,
				backgroundColor: background,
				fontSize: '0.95em',
				lineHeight: 1.5,
			}}
		>
			<span style={{ display: 'flex', alignItems: 'center', gap: '0.5em', flexWrap: 'wrap' }}>
				{actionable ? (
					<button
						type="button"
						data-testid="codex-git-action-button"
						disabled={running}
						aria-label={plan.command ? `${plan.label}. Runs: ${plan.command}` : plan.label}
						onClick={run}
						style={{
							padding: '0.1em 0.6em',
							borderRadius: '999px',
							border: `1px solid ${borderColor}`,
							backgroundColor: background,
							color: buttonText,
							fontWeight: 600,
							fontSize: '0.9em',
							cursor: running ? 'default' : 'pointer',
							opacity: running ? 0.6 : 1,
						}}
					>
						{running ? `${plan.label}...` : plan.label}
					</button>
				) : (
					<span style={{ color: theme.colors.textDim, fontWeight: 600 }}>{plan.label}</span>
				)}
			</span>
			{plan.command && (
				<span
					data-testid="codex-git-action-command"
					style={{
						display: 'block',
						marginTop: '0.3em',
						fontFamily: 'var(--font-mono, monospace)',
						fontSize: '0.85em',
						color: theme.colors.textDim,
						wordBreak: 'break-all',
					}}
				>
					{plan.command}
				</span>
			)}
			{plan.note && !actionable && (
				/*
				 * Only ever drawn where there is no button. A reader looking at a
				 * command with nothing to press has to be told why, or the card reads
				 * as a control that failed to render.
				 */
				<span
					data-testid="codex-git-action-note"
					style={{
						display: 'block',
						marginTop: '0.2em',
						fontSize: '0.8em',
						color: theme.colors.textDim,
						fontStyle: 'italic',
					}}
				>
					{plan.note}
				</span>
			)}
		</span>
	);
}
