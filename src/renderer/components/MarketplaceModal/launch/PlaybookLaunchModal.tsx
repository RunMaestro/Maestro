/**
 * PlaybookLaunchModal - the dialog behind the Exchange's Launch button.
 *
 * A playbook that ships a `launch` block (see `PlaybookLaunchSpec`) is configured by a short form
 * instead of by editing its prompt. Top to bottom:
 *
 * 1. the playbook's title and author, and its `intro`;
 * 2. the preconditions: the `requires` list, why the playbook cannot launch here, the
 *    `maestro-cli` row (with its Install button) and the `confirm` checkbox;
 * 3. the typed questions, then the `advanced` ones in a collapsed section;
 * 4. **Run on**: the current agent, an existing agent, or a new agent set up in the New Agent
 *    modal in capture mode;
 * 5. "Save as a reusable playbook".
 *
 * The footer has Cancel and Launch. Launch stays off, with the reason beside it, until the
 * answers pass `validateLaunchValues`, the chosen agent can be launched on, a `confirm` is
 * ticked, and a `maestro-cli` the playbook requires is installed.
 *
 * The dialog never edits an agent and creates nothing until Launch. Launch hands the form to
 * `launchPlaybook()` (`services/playbookLaunch.ts`), which validates, creates the new agent only
 * then, and asks main to start the run. This component shows how that ended: field errors,
 * the failure beside the button, or `onLaunched` for the host to close the Exchange and tell
 * the person. A launch that fails after it created its agent keeps the agent and moves the
 * choice onto it, so the retry runs there instead of creating a second one.
 *
 * It is a dialog layered on the Exchange, not a destination, so it is not in `DESTINATION_MODALS`.
 */

import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
	MarketplacePlaybook,
	PlaybookLaunchInput,
	PlaybookLaunchSpec,
} from '../../../../shared/marketplace-types';
import { resolveLaunchValues, validateLaunchValues } from '../../../../shared/playbookLaunch';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import { useMaestroCliState } from '../../../hooks/utils/useMaestroCliState';
import { launchPlaybook, type PlaybookLaunchOutcome } from '../../../services/playbookLaunch';
import { useSessionStore } from '../../../stores/sessionStore';
import type { Theme } from '../../../types';
import { viewportModalSize } from '../../../utils/modalSizing';
import { hostPlatform } from '../../../utils/platformUtils';
import { captureException } from '../../../utils/sentry';
import { NewInstanceModal } from '../../NewInstanceModal';
import type { NewAgentDraft } from '../../NewInstanceModal/types';
import { Modal, ModalFooter } from '../../ui/Modal';
import { LaunchCheckbox } from './LaunchCheckbox';
import { LaunchInputField, type LaunchFieldValue } from './LaunchInputField';
import { LaunchIntro } from './LaunchIntro';
import { LaunchPreconditions } from './LaunchPreconditions';
import { LaunchRunOn } from './LaunchRunOn';
import { evaluateLaunchGate, firstLaunchBlocker, initialNewAgentDraft } from './launchAgents';
import { useLaunchTarget } from './useLaunchTarget';

/**
 * The launch dialog sits above the Exchange, which is a `document.body` portal at z-index 9999.
 * Equal z-indexes fall back to document order, and the dialog mounts later, but a number does
 * not depend on that. The New Agent modal it opens must sit above the dialog.
 */
const LAUNCH_MODAL_Z_INDEX = 10000;
const NEW_AGENT_LAYER_Z_INDEX = 10001;

/** Said on a Browse button when the launch runs on an SSH remote (the Exchange footer's wording). */
const BROWSE_REMOTE_REASON = 'Browse is not available for remote sessions';

const FAULT_MESSAGE = 'The launch failed unexpectedly. Try again.';
const INVALID_ANSWERS_MESSAGE = 'Some answers are not valid. Fix them and launch again.';
const KEPT_AGENT_NOTE = 'The new agent was kept, so you can launch on it again.';

/** A launch that started, as `launchPlaybook()` reports it. */
export type StartedLaunch = Extract<PlaybookLaunchOutcome, { status: 'started' }>;

export interface PlaybookLaunchModalProps {
	theme: Theme;
	/** The Exchange playbook to launch. A playbook without a `launch` block draws nothing. */
	playbook: MarketplacePlaybook;
	/** Cancel, the close button or Escape. Not offered while a launch is starting. */
	onClose: () => void;
	/**
	 * The Auto Run started. The dialog stays locked after this, so the host closes it (and the
	 * Exchange) and tells the person which agent is running the playbook.
	 */
	onLaunched: (launched: StartedLaunch) => void;
}

/** The form's answers: one entry per input the person has been asked. */
type Answers = Record<string, LaunchFieldValue | undefined>;

interface LaunchDialogProps extends PlaybookLaunchModalProps {
	spec: PlaybookLaunchSpec;
}

function LaunchDialog({ theme, playbook, spec, onClose, onLaunched }: LaunchDialogProps) {
	const sessions = useSessionStore((state) => state.sessions);
	const choice = useLaunchTarget();

	const [answers, setAnswers] = useState<Answers>(() => ({ ...resolveLaunchValues(spec) }));
	const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
	const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
	const [confirmed, setConfirmed] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [keepSavedPlaybook, setKeepSavedPlaybook] = useState(false);
	const [newAgentOpen, setNewAgentOpen] = useState(false);
	const [newAgentSeed, setNewAgentSeed] = useState<Partial<NewAgentDraft>>({});
	const [submitting, setSubmitting] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	// Read synchronously: Enter on the Launch button fires its key handler and its click.
	const submittingRef = useRef(false);
	const advancedId = useId();

	const defaultSize = useMemo(() => viewportModalSize({ width: 0.5, height: 0.85 }), []);
	const runningVersion = useMemo(
		() => (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown'),
		[]
	);
	const platform = useMemo(() => hostPlatform(), []);

	// maestro-cli. Its state matters only for a playbook that mentions it, and only for an agent on
	// this machine: the CLI here cannot reach a remote. Switching the Run on choice to or from a
	// remote agent re-reads it.
	const cliMode = spec.preconditions?.maestroCli;
	const maestroCli = useMaestroCliState({ isOpen: cliMode !== undefined && !choice.remote });
	const cliUnread = maestroCli.status === null && maestroCli.statusError === null;
	const gate = useMemo(
		() =>
			evaluateLaunchGate(spec, {
				runningVersion,
				platform,
				sshRemote: choice.remote,
				maestroCliInstalled: maestroCli.status?.installed === true,
			}),
		[spec, runningVersion, platform, choice.remote, maestroCli.status?.installed]
	);

	// The answers the run would use, and what is wrong with them.
	const errors = useMemo(
		() => validateLaunchValues(spec, resolveLaunchValues(spec, answers)),
		[spec, answers]
	);
	// An error shows once the person has changed that answer, or when a launch refused it. A blank
	// required question is marked by its asterisk and by the line beside Launch, not by red text on
	// a form nobody has touched yet.
	const shownErrors = useMemo(() => {
		const shown: Record<string, string> = {};
		for (const [name, message] of Object.entries(errors)) {
			if (touched.has(name)) shown[name] = message;
		}
		return { ...shown, ...serverErrors };
	}, [errors, touched, serverErrors]);

	const primaryInputs = useMemo(
		() => spec.inputs.filter((input) => !input.advanced),
		[spec.inputs]
	);
	const advancedInputs = useMemo(
		() => spec.inputs.filter((input) => input.advanced),
		[spec.inputs]
	);
	// A hidden question that blocks Launch, or that a launch refused, must not stay hidden.
	const advancedHasError = advancedInputs.some(
		(input) => errors[input.name] !== undefined || serverErrors[input.name] !== undefined
	);
	const advancedShown = advancedOpen || advancedHasError;

	const blocker = firstLaunchBlocker({
		gate,
		checkingMaestroCli: cliMode !== undefined && !choice.remote && cliUnread,
		targetProblem: choice.problem,
		confirmationPending: Boolean(spec.preconditions?.confirm) && !confirmed,
		invalidAnswers: Object.keys(errors).length,
	});
	const canLaunch = blocker === null && choice.target !== null && !submitting;

	const handleAnswerChange = useCallback((name: string, value: LaunchFieldValue | undefined) => {
		setAnswers((previous) => ({ ...previous, [name]: value }));
		setTouched((previous) => (previous.has(name) ? previous : new Set(previous).add(name)));
		setServerErrors((previous) => {
			if (!(name in previous)) return previous;
			const next = { ...previous };
			delete next[name];
			return next;
		});
		setFailure(null);
	}, []);

	const handleClose = useCallback(() => {
		if (!submittingRef.current) onClose();
	}, [onClose]);

	const openNewAgentModal = useCallback(() => {
		// The first visit starts from the playbook and the current agent; Edit starts from what
		// was captured. The modal reads the seed once per open.
		setNewAgentSeed(
			choice.draft ?? initialNewAgentDraft(playbook.title, choice.currentSession ?? undefined)
		);
		setNewAgentOpen(true);
	}, [choice.draft, choice.currentSession, playbook.title]);

	const closeNewAgentModal = useCallback(() => setNewAgentOpen(false), []);

	const { setDraft } = choice;
	const handleCapture = useCallback(
		(draft: NewAgentDraft) => {
			setDraft(draft);
			setNewAgentOpen(false);
			setFailure(null);
		},
		[setDraft]
	);

	const handleLaunch = async () => {
		const target = choice.target;
		if (!canLaunch || target === null || submittingRef.current) return;
		submittingRef.current = true;
		setSubmitting(true);
		setFailure(null);
		setServerErrors({});

		let outcome: PlaybookLaunchOutcome;
		try {
			outcome = await launchPlaybook({
				playbookId: playbook.id,
				spec,
				answers,
				target,
				keepSavedPlaybook,
			});
		} catch (error) {
			// A fault: the service rejects only for what it does not know how to report.
			captureException(error, {
				extra: { operation: 'playbookLaunch:submit', playbookId: playbook.id },
			});
			submittingRef.current = false;
			setSubmitting(false);
			setFailure(FAULT_MESSAGE);
			return;
		}

		if (outcome.status === 'started') {
			// Stay locked: once the run has started the dialog never offers another launch, and the
			// host closes it.
			onLaunched(outcome);
			return;
		}
		submittingRef.current = false;
		setSubmitting(false);
		if (outcome.status === 'invalid') {
			setServerErrors(outcome.fieldErrors);
			setFailure(INVALID_ANSWERS_MESSAGE);
			return;
		}
		// The service already raised a toast for an agent it kept; the dialog moves onto it.
		if (outcome.createdSessionId) choice.switchToExistingAgent(outcome.createdSessionId);
		setFailure(outcome.createdSessionId ? `${outcome.error} ${KEPT_AGENT_NOTE}` : outcome.error);
	};

	const renderField = (input: PlaybookLaunchInput) => (
		<LaunchInputField
			key={input.name}
			theme={theme}
			input={input}
			value={answers[input.name]}
			onChange={handleAnswerChange}
			error={shownErrors[input.name]}
			disabled={submitting}
			browseDisabledReason={choice.remote ? BROWSE_REMOTE_REASON : undefined}
		/>
	);

	const launchLabel = submitting
		? 'Launching...'
		: choice.runOn === 'new'
			? 'Create agent and launch'
			: choice.summary
				? `Launch on ${choice.summary.name}`
				: 'Launch';
	const statusText = failure ?? blocker ?? '';

	return (
		<>
			<Modal
				theme={theme}
				title="Launch playbook"
				priority={MODAL_PRIORITIES.MARKETPLACE_LAUNCH}
				onClose={handleClose}
				width={640}
				resizeKey="marketplace-launch"
				defaultSize={defaultSize}
				minSize={{ width: 520, height: 420 }}
				maxSize={{ width: 860 }}
				zIndex={LAUNCH_MODAL_Z_INDEX}
				portal
				testId="playbook-launch-modal"
				contentClassName="p-5 overflow-y-auto flex-1 min-h-0 select-none"
				footer={
					<div className="flex items-center gap-3 w-full">
						<div
							role={failure ? 'alert' : 'status'}
							className="mr-auto min-w-0 text-xs select-text"
							style={{ color: failure ? theme.colors.error : theme.colors.textDim }}
							data-testid="launch-status"
						>
							{statusText}
						</div>
						<ModalFooter
							theme={theme}
							onCancel={handleClose}
							onConfirm={() => void handleLaunch()}
							confirmLabel={launchLabel}
							confirmDisabled={!canLaunch}
							cancelDisabled={submitting}
						/>
					</div>
				}
			>
				<fieldset disabled={submitting} className="min-w-0 space-y-5">
					<header className="space-y-0.5">
						<h3
							className="text-base font-bold select-text"
							style={{ color: theme.colors.textMain }}
							data-testid="launch-playbook-title"
						>
							{playbook.title}
						</h3>
						<p
							className="text-xs select-text"
							style={{ color: theme.colors.textDim }}
							data-testid="launch-playbook-author"
						>
							by {playbook.author}
						</p>
					</header>

					{spec.intro && <LaunchIntro theme={theme} content={spec.intro} />}

					<LaunchPreconditions
						theme={theme}
						preconditions={spec.preconditions}
						gate={gate}
						maestroCli={maestroCli}
						remote={choice.remote}
						confirmed={confirmed}
						onConfirmedChange={setConfirmed}
						disabled={submitting}
					/>

					{primaryInputs.length > 0 && (
						<div className="space-y-4" data-testid="launch-inputs">
							{primaryInputs.map(renderField)}
						</div>
					)}

					{advancedInputs.length > 0 && (
						<section data-testid="launch-advanced">
							<button
								type="button"
								onClick={() => setAdvancedOpen((open) => !open)}
								disabled={advancedHasError}
								aria-expanded={advancedShown}
								aria-controls={advancedId}
								title={
									advancedHasError ? 'Fix the answers inside to collapse this section' : undefined
								}
								className="flex items-center gap-1 text-xs font-bold uppercase opacity-70 hover:opacity-100 disabled:opacity-70"
								style={{ color: theme.colors.textMain }}
								data-testid="launch-advanced-toggle"
							>
								{advancedShown ? (
									<ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
								) : (
									<ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
								)}
								Advanced
								<span className="font-normal normal-case">({advancedInputs.length})</span>
							</button>
							{advancedShown && (
								<div
									id={advancedId}
									className="mt-3 space-y-4 pl-4 border-l"
									style={{ borderColor: theme.colors.border }}
									data-testid="launch-advanced-inputs"
								>
									{advancedInputs.map(renderField)}
								</div>
							)}
						</section>
					)}

					<LaunchRunOn
						theme={theme}
						choice={choice}
						onSetUpNewAgent={openNewAgentModal}
						disabled={submitting}
					/>

					<LaunchCheckbox
						theme={theme}
						checked={keepSavedPlaybook}
						onChange={setKeepSavedPlaybook}
						label="Save as a reusable playbook"
						help="Keeps the playbook in your saved playbooks. Otherwise it is removed when the run finishes."
						disabled={submitting}
						testId="launch-keep-saved"
					/>
				</fieldset>
			</Modal>

			{newAgentOpen &&
				createPortal(
					// A stacking context of its own: the New Agent modal does not portal, and its
					// default z-index would leave it behind this dialog and the Exchange.
					<div
						className="relative"
						style={{ zIndex: NEW_AGENT_LAYER_Z_INDEX }}
						data-testid="launch-new-agent-layer"
					>
						<NewInstanceModal
							mode="capture"
							isOpen
							theme={theme}
							existingSessions={sessions}
							initialDraft={newAgentSeed}
							onCapture={handleCapture}
							onClose={closeNewAgentModal}
						/>
					</div>,
					document.body
				)}
		</>
	);
}

export function PlaybookLaunchModal(props: PlaybookLaunchModalProps) {
	const spec = props.playbook.launch;
	if (!spec) return null;
	return <LaunchDialog {...props} spec={spec} />;
}
