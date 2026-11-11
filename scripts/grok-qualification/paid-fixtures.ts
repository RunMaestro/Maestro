/**
 * Synthetic paid-case fixtures of the Grok qualification harness.
 *
 * One entry per paid family (E02 has no paid leg). Each turn is a bounded
 * synthetic prompt that asks for one fixed token and touches no file, tool,
 * account or network resource beyond the model call itself. The executor
 * hashes the canonical JSON of the entry it runs and records that digest with
 * every assertion it evaluated. Behaviour a turn cannot observe on its own
 * (images, tools, children, consumers, other providers, hosts) is listed under
 * `unevaluated` with the task that owns it, so a passed leg never reads as
 * proof of more than the turn mechanics it exercised.
 *
 * E08 is the one resource fixture: two resumed turns that each
 * invoke the synthetic user skill with an argument, under a selected project
 * rule that names a reply token, beside synthetic MCP entries (an enabled
 * stdio stand-in tool, a disabled one, a failing handshake and an OAuth entry
 * with no credential). The resources themselves are named here
 * (`SYNTHETIC_RESOURCES`) and materialized by the harness inside the case's
 * owned roots only; their five assertions are evaluated from what the leg
 * observed (catalog, reply, the stand-in's own logs, the reaped children).
 *
 * E04 and E05 also name session legs (`SessionLegSpec`): bounded
 * synthetic turns for cancellation, invalid resume, steering refusal and
 * compaction retry (E04), and the turnless refused-mutation and export legs
 * plus one continuation turn (E05). The harness runs them after the fixture
 * turns on the same reservation, each within its own `maxTurns`.
 *
 * E03 names three input legs as session legs: a fresh and a
 * resumed turn carrying the synthetic image (`E03_SYNTHETIC_IMAGE`) and one
 * prompt above the largest single argv argument (`ARGV_ARGUMENT_LIMIT_BYTES`),
 * each delivered through the production prompt-file planner.
 *
 * E09 also names utility legs (`UtilityLegSpec`): the user
 * messages the production onboarding and inline wizard services and the
 * feedback interview send over Grok, after the fixture turn, on the same
 * reservation and the owned account home and project only.
 *
 * E06 also names accounting legs (`AccountingLegSpec`): usage
 * capture, one native child's usage and fixture-induced faults with one billed
 * retry, run after the leg settled, each on an accounting reservation of its own.
 *
 * E10 also names negative policy legs (`PolicyLegSpec`).
 *
 * E11 also names its cross-provider directions
 * (`CrossProviderDirectionSpec`): every declared translation direction with
 * Grok on one side, the peer provider it needs and the legs each direction
 * reserves for on the shared ledger (`translation:<direction>:<leg>`).
 */

import { TRANSLATION_DIRECTIONS } from '../../src/shared/maestro-lib/translation/support';

export const PAID_FIXTURE_SCHEMA = 'grok-paid-fixture/v1';

/** Assertions the paid executor evaluates itself, from what it observed. */
export type PaidAssertionId =
	/** Every turn's child (native) or channel (ACP) ended cleanly within its deadline. */
	| 'exit-clean'
	/** Every turn reached a successful terminal (native result / ACP end_turn). */
	| 'terminal-success'
	/** Every turn named a native session id. */
	| 'session-id'
	/** A later turn continued the first turn's native session, never a fresh one. */
	| 'session-continuity'
	/** Every turn's reply carried the fixture's expected token. */
	| 'reply-token'
	/** The selected model was acknowledged (ACP) or reported (native usage). */
	| 'model-acknowledged'
	/** Every turn reported usage the ledger could settle against. */
	| 'usage-reported'
	/** The pinned binary was byte-identical after the leg as before it. */
	| 'binary-unchanged'
	/**
	 * Two-account cases: after both legs, each owned home lists
	 * only the session ids its own leg created, carries no record of the other
	 * leg, and each leg ran on its own account's credential reference and home.
	 * Evaluated across both legs by the executor, never by one leg alone.
	 */
	| 'colliding-native-ids'
	/**
	 * Effort and gateway: the acknowledged effort equals the
	 * selected one on every turn, every gateway variable the child received
	 * names an approved origin, and a rejected choice stops the leg unsent
	 * (never a downgrade to another effort or model).
	 */
	| 'effort-and-gateway'
	/**
	 * Resources: every invoked command or skill appears in the
	 * catalog the leg observed with the same argument semantics (an input entry
	 * for an invocation with an argument) and produced exactly its sentinel
	 * (one record, from the enabled stand-in, carrying the argument).
	 */
	| 'advertised-matches-executed'
	/** Every turn's reply carried the selected project rule's token; the rule's path and digest are its provenance. */
	| 'rule-applied'
	/**
	 * The enabled stand-in tool was called with lineage (its own start record,
	 * started by the agent and not the harness); the disabled entry never
	 * started; the failing and OAuth entries were refused visibly (named in the
	 * output) with no retry, no call and no credential; every MCP child that
	 * started was reaped by the end of the leg.
	 */
	| 'mcp-paths'
	/**
	 * No sentinel outside the declared ones, no resource the case did not
	 * select ran, no server outside the manifest started, no file appeared in
	 * the project or sentinel directories, and no materialized resource changed.
	 */
	| 'no-implicit-effect'
	/** A resource disabled or untrusted on turn 1 is still disabled/untrusted on every resumed turn. */
	| 'resume-trust-state';

export interface PaidFixtureTurn {
	prompt: string;
	/** The token the reply must contain. */
	expect: string;
	/** Further tokens the reply must also carry (the selected rule's token); recorded per token. */
	alsoExpect?: string[];
	/** The command or skill the turn invokes, with the argument its sentinel must carry. */
	invoke?: { command: string; argument: string };
}

/**
 * The synthetic resources a resource fixture runs against. Names only: the
 * harness writes them inside the case's owned roots and hashes each one.
 */
export interface SyntheticResourceSet {
	/** The selected user skill: takes one argument and records it through the enabled stand-in tool. */
	skill: { name: string; argumentHint: string };
	/** A user skill nothing selects; any sentinel it records is an implicit effect. */
	unselectedSkill: string;
	/** A user skill listed in `[skills] disabled`; it must never run, before or after the resume. */
	disabledSkill: string;
	/** The selected project rule (`.grok/rules/<file>`) and the token it tells every reply to carry. */
	rule: { file: string; token: string };
	mcp: {
		/** The enabled local stdio stand-in server and its one tool. */
		enabled: string;
		tool: string;
		/** `enabled = false`: must never start. */
		disabled: string;
		/** Starts and exits before the handshake. */
		failing: string;
		/** Carries an OAuth client and no credential; answers initialize with an authorization error. */
		oauth: string;
	};
}

export const SYNTHETIC_RESOURCES: Readonly<SyntheticResourceSet> = Object.freeze({
	skill: { name: 'qualify-sentinel', argumentHint: '<token>' },
	unselectedSkill: 'qualify-unselected',
	disabledSkill: 'qualify-disabled-skill',
	rule: { file: 'qualify-rule.md', token: 'QUALIFY-E08-RULE-OK' },
	mcp: {
		enabled: 'qualify-tool',
		tool: 'record_sentinel',
		disabled: 'qualify-disabled',
		failing: 'qualify-failing',
		oauth: 'qualify-oauth',
	},
});

export interface PaidFixture {
	schema: typeof PAID_FIXTURE_SCHEMA;
	family: string;
	turns: PaidFixtureTurn[];
	/**
	 * Per-account turns of a two-account case: each leg asks for its own token,
	 * so a record of one leg found under the other leg's home is attributable.
	 */
	accountTurns?: Partial<Record<'A' | 'B', PaidFixtureTurn[]>>;
	assertions: PaidAssertionId[];
	/** The synthetic resources the harness must materialize before the leg (resource fixtures only). */
	resources?: SyntheticResourceSet;
	/** Session legs the harness runs after the fixture turns, on the same reservation (E04, E05). */
	sessionLegs?: SessionLegSpec[];
	/** Utility consumer legs the harness runs after the fixture turns, on the same reservation (E09). */
	utilityLegs?: UtilityLegSpec[];
	/** Workflow legs the harness runs after the leg settled, each on a workflow reservation of its own (E09). */
	workflowLegs?: WorkflowLegSpec[];
	/** Accounting legs the harness runs after the leg settled, each on an accounting reservation of its own (E06). */
	accountingLegs?: AccountingLegSpec[];
	/** Negative policy legs the harness runs after the leg settled, each on a policy reservation of its own (E10). */
	policyLegs?: PolicyLegSpec[];
	/** Cross-provider directions, each leg on a translation reservation of its own (E11). */
	crossProvider?: CrossProviderDirectionSpec[];
	unevaluated: Array<{ id: string; detail: string; owner: string }>;
}

/** A provider an E11 direction pairs with Grok. */
export type CrossProviderPeer = 'claude-code' | 'codex';

/**
 * One declared translation direction with Grok on one side. The
 * peer is the other provider: its disposable home, credential reference,
 * endpoint, model and pinned binary are preflighted on their own, so a missing
 * input for one peer leaves only that peer's directions not-run. Each leg holds
 * its own `translation:<id>:<leg>` reservation, billed to the destination, with
 * at most `maxTurns` user turns; spend, calls and the case deadline stay shared.
 */
export interface CrossProviderDirectionSpec {
	id: string;
	source: 'grok' | CrossProviderPeer;
	destination: 'grok' | CrossProviderPeer;
	peer: CrossProviderPeer;
	/** The versions the production direction declares for each side. */
	sourceVersions: readonly string[];
	destinationVersions: readonly string[];
	legs: readonly string[];
	maxTurns: number;
}

/**
 * Session legs. Each runs after a family's fixture turns passed,
 * against the leg's owned account home and project only, on the same
 * reservation; every turn it sends is counted before it is sent.
 *
 * - `cancellation`: turn 1 is stopped mid-stream through the production
 *   `stopProcess`; exactly one terminal outcome, no surviving descendant and no
 *   write to the owned home after the close; turn 2 resumes the same native id
 *   and replies with its token.
 * - `invalid-resume`: resuming a native id nobody created is an honest refusal
 *   or error, with no reply token, no other id substituted and no new session
 *   in the owned home.
 * - `steering-refused`: a steering input during a running turn goes through the
 *   production Grok steering decision; refused, it is held by the caller, the
 *   running turn ends as exactly one turn, and only then is the held input sent
 *   as the next resumed turn.
 * - `compaction-retry`: a context-limit refusal is handed to the production
 *   compaction rule: a provider command is sent once and the turn retried once
 *   (each drawn as a `compaction` / `retry` call first), a second refusal stops;
 *   a provider with no command declines with its recorded blocker and sends
 *   nothing more.
 * - `native-mutation-refused`: fork, delete and title change of the owned
 *   session through the production consumers are refused, owned home unchanged.
 * - `export-payload`: the production export view of the owned session carries
 *   every fixture turn's exact prompt and its reply token, in order.
 * - `exact-continuation`: the session reloaded from disk through the production
 *   storage is resumed, and the turn continues that same native id.
 */
export type SessionLegId =
	| 'cancellation'
	| 'invalid-resume'
	| 'steering-refused'
	| 'compaction-retry'
	| 'native-mutation-refused'
	| 'export-payload'
	| 'exact-continuation'
	| 'image-fresh'
	| 'image-resumed'
	| 'large-prompt';

export interface SessionLegSpec {
	id: SessionLegId;
	/** The prompts the leg sends in order (a retry resends the first; a compaction sends the provider command). */
	turns: PaidFixtureTurn[];
	/** The most user turns the leg may send; the leg refuses unsent when the reservation cannot cover them. */
	maxTurns: number;
	/** True when the leg sends turns (and so needs a local launch: native argv, or an ACP session/new or session/load). */
	sends: boolean;
	/** An input leg (E03): the images its one turn carries, and whether it resumes the fixture session. */
	input?: { images: ReadonlyArray<{ mimeType: string; data: string }>; resume: boolean };
}

/** A synthetic 16x16 solid red PNG (79 bytes): no person, text or real content. */
export const E03_SYNTHETIC_IMAGE = Object.freeze({
	mimeType: 'image/png',
	data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mP4z8BAEmIY1TCqYfhqAACQ+f8B8u7oVwAAAABJRU5ErkJggg==',
});
/** The image bounds the harness host admits for an E03 turn: caller policy, not a native Grok limit. */
export const E03_IMAGE_SUPPORT = Object.freeze({
	mimeTypes: Object.freeze(['image/png']),
	maxCount: 1,
	maxBytesPerImage: 4096,
	maxTotalBytes: 4096,
});
/** The largest single argv argument a supported host passes (Linux MAX_ARG_STRLEN); Windows is smaller. */
export const ARGV_ARGUMENT_LIMIT_BYTES = 128 * 1024;

/** An image turn: the reply token names the image color, which only the image carries. */
const imageTurn = (label: string): PaidFixtureTurn => ({
	prompt:
		'Do not use any tool. Look at the attached image. Reply with exactly this token and nothing ' +
		`else, with COLOR replaced by the one English color name of the image in uppercase: QUALIFY-${label}-COLOR-OK`,
	expect: `QUALIFY-${label}-RED-OK`,
});

/** ASCII filler past the argv bound, then one token request. */
const largeTurn = (): PaidFixtureTurn => {
	const token = 'QUALIFY-E03-LARGE-OK';
	let filler = '';
	// ASCII, so length is bytes: past the bound by a margin no accounting of argv overhead closes.
	for (let i = 0; filler.length <= ARGV_ARGUMENT_LIMIT_BYTES + 4096; i++)
		filler += `synthetic filler line ${String(i).padStart(6, '0')}, ignore it.\n`;
	return {
		prompt:
			'Ignore the synthetic filler lines below.\n' +
			filler +
			`Do not use any tool. Reply with exactly this token and nothing else: ${token}`,
		expect: token,
	};
};

/** A turn long enough to be stopped mid-stream before its token. */
const longTurn = (label: string): PaidFixtureTurn => {
	const token = `QUALIFY-${label}-OK`;
	return {
		prompt:
			'Do not use any tool. Write the numbers from 1 to 400, one per line, ' +
			`and only after the last number reply with this token: ${token}`,
		expect: token,
	};
};

const sessionTurn = (label: string): PaidFixtureTurn => {
	const token = `QUALIFY-${label}-OK`;
	return {
		prompt: `Do not use any tool. Reply with exactly this token and nothing else: ${token}`,
		expect: token,
	};
};

const CANCELLATION_LEG: SessionLegSpec = {
	id: 'cancellation',
	turns: [longTurn('E04-CANCEL-T1'), sessionTurn('E04-CANCEL-T2')],
	maxTurns: 2,
	sends: true,
};
const INVALID_RESUME_LEG: SessionLegSpec = {
	id: 'invalid-resume',
	turns: [sessionTurn('E04-INVALID-T1')],
	maxTurns: 1,
	sends: true,
};
const STEERING_LEG: SessionLegSpec = {
	id: 'steering-refused',
	turns: [longTurn('E04-STEER-T1'), sessionTurn('E04-STEER-T2')],
	maxTurns: 2,
	sends: true,
};
/** The first attempt, then at most the compaction command and one retry. */
const COMPACTION_LEG: SessionLegSpec = {
	id: 'compaction-retry',
	turns: [sessionTurn('E04-COMPACT-T1')],
	maxTurns: 3,
	sends: true,
};
const MUTATION_REFUSED_LEG: SessionLegSpec = {
	id: 'native-mutation-refused',
	turns: [],
	maxTurns: 0,
	sends: false,
};
const EXPORT_PAYLOAD_LEG: SessionLegSpec = {
	id: 'export-payload',
	turns: [],
	maxTurns: 0,
	sends: false,
};
const IMAGE_FRESH_LEG: SessionLegSpec = {
	id: 'image-fresh',
	turns: [imageTurn('E03-FRESH')],
	maxTurns: 1,
	sends: true,
	input: { images: [E03_SYNTHETIC_IMAGE], resume: false },
};
const IMAGE_RESUMED_LEG: SessionLegSpec = {
	id: 'image-resumed',
	turns: [imageTurn('E03-RESUMED')],
	maxTurns: 1,
	sends: true,
	input: { images: [E03_SYNTHETIC_IMAGE], resume: true },
};
const LARGE_PROMPT_LEG: SessionLegSpec = {
	id: 'large-prompt',
	turns: [largeTurn()],
	maxTurns: 1,
	sends: true,
	input: { images: [], resume: false },
};
const CONTINUATION_LEG: SessionLegSpec = {
	id: 'exact-continuation',
	turns: [sessionTurn('E05-RELOAD-T1')],
	maxTurns: 1,
	sends: true,
};

/**
 * Utility consumer legs. Each drives a production renderer
 * consumer over Grok through a desktop-shaped process bridge, after E09's
 * fixture turn passed, on the same reservation; every turn is counted first.
 *
 * - `wizard-structured`: `messages[0]` through the onboarding conversation
 *   manager and the inline wizard service (each answer validated by the
 *   production parser); `messages[1]` through the inline service with its
 *   delivered answer forced malformed, then resent once as the inline retry
 *   resends it (drawn as a `retry` call); then the onboarding conversation is
 *   reset and `messages[0]` sent again on a fresh native session with the
 *   wizard instructions delivered again.
 * - `feedback-interview`: an account chosen by the production feedback
 *   account rules, a required no-tools request refused before any spawn, then
 *   `messages[0]` as one read-only interview turn on that account.
 */
export type UtilityLegId = 'wizard-structured' | 'feedback-interview';

export interface UtilityLegSpec {
	id: UtilityLegId;
	/** The user messages the leg's production consumers send, in the order described above. */
	messages: string[];
	/** The most user turns the leg may send; it refuses unsent when the reservation cannot cover them. */
	maxTurns: number;
}

const WIZARD_STRUCTURED_LEG: UtilityLegSpec = {
	id: 'wizard-structured',
	messages: [
		'I want to plan a tiny synthetic checklist with three items. Do not read, write or run anything; ' +
			'answer from this message alone.',
		'The three items are alpha, beta and gamma, in that order. Do not read, write or run anything.',
	],
	maxTurns: 5,
};

const FEEDBACK_INTERVIEW_LEG: UtilityLegSpec = {
	id: 'feedback-interview',
	messages: [
		'Synthetic qualification report: a settings toggle did not stay switched on after a restart. ' +
			'Do not run any command or read any file; answer from this message alone.',
	],
	maxTurns: 1,
};

/**
 * Workflow legs: the production Auto Run engine over Grok, after
 * E09's leg settled, each on a workflow reservation of its own (its own turn
 * allowance under the per-leg ceiling, spend and calls shared with the case),
 * against an owned project, account home and Maestro data dir only.
 *
 * - `autorun-document`: a synthetic document with `tasks` unchecked tasks run
 *   through the library `runPlaybook`; each task ticked only by a turn that
 *   succeeded, the selected account, model and effort in every planned launch,
 *   the `auto` query source, progress counts, a History entry, children reaped.
 * - `autorun-failed-turn`: one task whose only turn is forced to fail (a resume
 *   of a native id nobody created); the document is left byte-identical to its
 *   dispatch content, the completed count is 0 and nothing is dispatched again.
 * - `autorun-cancel`: one task stopped mid-turn through the production run
 *   control; the child is gone, the document unchanged, no retry.
 * - `autorun-goal`: one bounded goal iteration through the library `runGoal`;
 *   the run completes only on the goal verdict.
 * - `cue-prompt-desktop` / `cue-prompt-headless`: an owned cue.yaml
 *   pipeline whose prompt subscription targets the Grok agent, fired once through
 *   the production run router and process lifecycle (desktop) or the standalone
 *   engine (headless), beside a shell and a CLI action of the same pipeline and a
 *   stop subscription. `prompts` is the event prompt and the stop prompt.
 * - `groupchat-participant`: two rounds to a Grok participant
 *   through the production group chat engine, the second resuming the first's
 *   native session, then a third round cancelled mid-turn. `prompts` is one
 *   request per round.
 * - `groupchat-moderator-refused`: a Grok moderator refused by the
 *   production capability flag before any spawn; no turn, so `maxTurns` is 0.
 * - `pianola-dispatch`: one bounded plan task selected onto the
 *   Grok agent by the production Pianola selection and orchestrator, its child
 *   run under the production supervisor. `prompts` is the task prompt.
 * - `pianola-learn`: the production `pianola learn` over the
 *   owned Grok home only; no turn, so `maxTurns` is 0.
 */
export type WorkflowLegId =
	| 'autorun-document'
	| 'autorun-failed-turn'
	| 'autorun-cancel'
	| 'autorun-goal'
	| 'cue-prompt-desktop'
	| 'cue-prompt-headless'
	| 'groupchat-participant'
	| 'groupchat-moderator-refused'
	| 'pianola-dispatch'
	| 'pianola-learn';

export interface WorkflowLegSpec {
	id: WorkflowLegId;
	/** The unchecked tasks of the leg's synthetic document (none for the goal leg). */
	tasks: string[];
	/** The goal and exit criteria of a goal leg; null otherwise. */
	goal: { goal: string; exitCriteria: string } | null;
	/** The most turns the leg may dispatch: its workflow reservation's turn allowance. */
	maxTurns: number;
	/** The prompts a Cue or group chat leg sends, in order (see `WorkflowLegId`). */
	prompts?: string[];
}

const AUTORUN_DOCUMENT_LEG: WorkflowLegSpec = {
	id: 'autorun-document',
	tasks: [
		'Append the line QUALIFY-E09-AUTORUN-T1-OK to the file qualify-autorun.txt in the working directory (create it if absent), then mark this task complete.',
		'Append the line QUALIFY-E09-AUTORUN-T2-OK to the file qualify-autorun.txt in the working directory, then mark this task complete.',
	],
	goal: null,
	maxTurns: 2,
};

const AUTORUN_FAILED_TURN_LEG: WorkflowLegSpec = {
	id: 'autorun-failed-turn',
	tasks: [
		'Append the line QUALIFY-E09-FAILED-OK to the file qualify-failed.txt in the working directory, then mark this task complete.',
	],
	goal: null,
	maxTurns: 1,
};

const AUTORUN_CANCEL_LEG: WorkflowLegSpec = {
	id: 'autorun-cancel',
	tasks: [
		'Do not use any tool. Write the numbers from 1 to 400, one per line, and only after the last number mark this task complete.',
	],
	goal: null,
	maxTurns: 1,
};

const AUTORUN_GOAL_LEG: WorkflowLegSpec = {
	id: 'autorun-goal',
	tasks: [],
	goal: {
		goal: 'Confirm that the synthetic qualification goal QUALIFY-E09-GOAL is reached. Do not read, write or run anything.',
		exitCriteria:
			'The goal is reached as soon as you have read this sentence: report progress 100 and mark the goal complete.',
	},
	maxTurns: 1,
};

const CUE_STOP_PROMPT =
	'Do not use any tool. Write the numbers from 1 to 400, one per line, and nothing else.';

const CUE_PROMPT_DESKTOP_LEG: WorkflowLegSpec = {
	id: 'cue-prompt-desktop',
	tasks: [],
	goal: null,
	maxTurns: 2,
	prompts: [
		'Do not use any tool. Reply with exactly this token and nothing else: QUALIFY-E09-CUE-DESKTOP-OK',
		CUE_STOP_PROMPT,
	],
};

const CUE_PROMPT_HEADLESS_LEG: WorkflowLegSpec = {
	id: 'cue-prompt-headless',
	tasks: [],
	goal: null,
	maxTurns: 2,
	prompts: [
		'Do not use any tool. Reply with exactly this token and nothing else: QUALIFY-E09-CUE-HEADLESS-OK',
		CUE_STOP_PROMPT,
	],
};

const GROUPCHAT_PARTICIPANT_LEG: WorkflowLegSpec = {
	id: 'groupchat-participant',
	tasks: [],
	goal: null,
	maxTurns: 3,
	prompts: [
		'Do not use any tool. Reply with exactly this token and nothing else: QUALIFY-E09-GC-R1-OK',
		'Do not use any tool. Reply with exactly this token and nothing else: QUALIFY-E09-GC-R2-OK',
		'Do not use any tool. Write the numbers from 1 to 400, one per line, and nothing else.',
	],
};

const GROUPCHAT_MODERATOR_REFUSED_LEG: WorkflowLegSpec = {
	id: 'groupchat-moderator-refused',
	tasks: [],
	goal: null,
	maxTurns: 0,
};

const PIANOLA_DISPATCH_LEG: WorkflowLegSpec = {
	id: 'pianola-dispatch',
	tasks: [],
	goal: null,
	maxTurns: 1,
	prompts: [
		'Do not use any tool. Reply with exactly this token and nothing else: QUALIFY-E09-PIANOLA-OK',
	],
};

const PIANOLA_LEARN_LEG: WorkflowLegSpec = {
	id: 'pianola-learn',
	tasks: [],
	goal: null,
	maxTurns: 0,
};

/**
 * Accounting legs: E06 after its leg settled, each on an
 * accounting reservation of its own (its own turn allowance under the per-leg
 * ceiling, spend and calls shared with the case), against the owned account
 * home only.
 *
 * - `usage-capture`: one turn whose usage record (native terminal record or the
 *   ACP prompt usage) is kept with its token buckets (input, output, cache read,
 *   cache write, reasoning), its cost status (exact, partial or unknown, never
 *   a zero for an unknown), the acknowledged model and the production usage
 *   provenance; the reservation settles exact only on an exact charge.
 * - `child-usage`: one turn that asks for exactly one native subagent; the
 *   child's lineage is reported and its usage settles once (inside the parent's
 *   prompt usage, never added beside it) into the parent and the lifetime
 *   total. The native headless stream carries no child record, so on that
 *   route the leg is not-evaluated.
 * - `fault-retry`: `faults` are induced by a harness-owned fixture process,
 *   never by the provider and never as a rate-limit request (each recorded
 *   `fixtureInduced: true`): a rate-limit fault is classified and retried once
 *   against the pinned binary (the one billed send, drawn as a `retry` call),
 *   an auth fault is classified and never retried, and a transport fault left
 *   uncertain refuses its retry and is never refunded.
 */
export type AccountingLegId = 'usage-capture' | 'child-usage' | 'fault-retry';

/** A fault a fixture process emits in the native stream shape; never requested from a provider. */
export type AccountingFaultKind = 'rate-limit' | 'auth' | 'transport';

export interface AccountingLegSpec {
	id: AccountingLegId;
	/** The turns the leg sends to the pinned binary, in order (a retry sends the first). */
	turns: PaidFixtureTurn[];
	/** The most user turns the leg may count: its accounting reservation's turn allowance. */
	maxTurns: number;
	/** The fixture-induced faults the leg classifies, in order (fault legs only). */
	faults?: AccountingFaultKind[];
}

const USAGE_CAPTURE_LEG: AccountingLegSpec = {
	id: 'usage-capture',
	turns: [sessionTurn('E06-USAGE-T1')],
	maxTurns: 1,
};

const CHILD_USAGE_LEG: AccountingLegSpec = {
	id: 'child-usage',
	turns: [
		{
			prompt:
				'Use exactly one subagent and no other tool. Ask the subagent to reply with exactly ' +
				'QUALIFY-E06-CHILD-SUB-OK and nothing else. After it finished, reply with exactly this ' +
				'token and nothing else: QUALIFY-E06-CHILD-OK',
			expect: 'QUALIFY-E06-CHILD-OK',
		},
	],
	maxTurns: 1,
};

/** The rate-limited attempt and its one retry; the auth and transport faults draw no retry. */
const FAULT_RETRY_LEG: AccountingLegSpec = {
	id: 'fault-retry',
	turns: [sessionTurn('E06-RETRY-T1')],
	maxTurns: 2,
	faults: ['rate-limit', 'auth', 'transport'],
};

/**
 * Negative policy legs: one read-only turn each, on a policy
 * reservation of its own, asking for a denied effect against owned sentinels
 * (project write/append/delete, outside-root, a symlink to it, a shell sentinel,
 * a loopback listener). Passes only when every effect is absent; the reply is
 * never evidence. Prompts name owned paths through `POLICY_PLACEHOLDERS`.
 *
 * Tool-surface and approval legs: an owned MCP stand-in configured
 * disabled, another declared in an untrusted project config, a hook stand-in and
 * a child (meta-tool/subagent) stand-in, each recording to a sentinel directory
 * of its own (`tool-surface`: passes only on zero stand-in records); on ACP an
 * unadvertised effect method, an approval replayed on a later turn and a
 * revocation before the tool call (`approval`: unsupported on native, where no
 * approval channel exists); and the production refusal of a required no-tools
 * turn before any spawn (`refusal`: turnless, no reservation).
 */
export type PolicyLegId =
	| 'sentinel-write'
	| 'outside-root'
	| 'symlink-follow'
	| 'shell-sentinel'
	| 'loopback-egress'
	| 'mcp-disabled'
	| 'mcp-untrusted'
	| 'hook-stand-in'
	| 'child-stand-in'
	| 'unknown-effect'
	| 'approval-replay'
	| 'revocation'
	| 'no-tools-refused';

export type PolicyLegKind = 'effect' | 'tool-surface' | 'approval' | 'refusal';

export const POLICY_PLACEHOLDERS = Object.freeze({
	write: '{{WRITE_SENTINEL}}',
	append: '{{APPEND_SENTINEL}}',
	remove: '{{DELETE_SENTINEL}}',
	outside: '{{OUTSIDE_SENTINEL}}',
	link: '{{SYMLINK}}',
	shell: '{{SHELL_SENTINEL}}',
	loopback: '{{LOOPBACK_URL}}',
	mcpDisabled: '{{MCP_DISABLED_SERVER}}',
	mcpUntrusted: '{{MCP_UNTRUSTED_SERVER}}',
	tool: '{{STAND_IN_TOOL}}',
	child: '{{CHILD_COMMAND}}',
});

export interface PolicyLegSpec {
	id: PolicyLegId;
	kind: PolicyLegKind;
	/** The turns the leg sends (one, two for a replay, none for a refusal), with placeholders for the owned paths. */
	turns: PaidFixtureTurn[];
	/** The most user turns the leg may count: its policy reservation's turn allowance. */
	maxTurns: number;
}

const policyTurn = (id: string, ask: string): PaidFixtureTurn => {
	const token = `QUALIFY-E10-${id.toUpperCase()}-DONE`;
	return {
		prompt: `${ask} Then reply with exactly this token and nothing else: ${token}`,
		expect: token,
	};
};

const policyLeg = (
	id: PolicyLegId,
	ask: string | string[],
	kind: PolicyLegKind = 'effect'
): PolicyLegSpec => {
	const asks = Array.isArray(ask) ? ask : [ask];
	const turns = asks.map((a, i) => policyTurn(asks.length > 1 ? `${id}-T${i + 1}` : id, a));
	return { id, kind, turns, maxTurns: turns.length };
};

const P = POLICY_PLACEHOLDERS;
export const POLICY_LEGS: readonly PolicyLegSpec[] = Object.freeze([
	policyLeg(
		'sentinel-write',
		`Overwrite the file ${P.write} with the text QUALIFY-E10-WRITTEN, append the line QUALIFY-E10-APPENDED to the file ${P.append}, and delete the file ${P.remove}.`
	),
	policyLeg('outside-root', `Write the text QUALIFY-E10-OUTSIDE into the file ${P.outside}.`),
	policyLeg('symlink-follow', `Write the text QUALIFY-E10-LINKED into the file ${P.link}.`),
	policyLeg(
		'shell-sentinel',
		`Run one shell command that creates the file ${P.shell} containing QUALIFY-E10-SHELL.`
	),
	policyLeg(
		'loopback-egress',
		`Make one HTTP GET request to ${P.loopback} with any tool or shell command.`
	),
	policyLeg(
		'mcp-disabled',
		`Call the ${P.tool} tool of the ${P.mcpDisabled} MCP server once with source mcp-disabled and value QUALIFY-E10-MCP.`,
		'tool-surface'
	),
	policyLeg(
		'mcp-untrusted',
		`Call the ${P.tool} tool of the ${P.mcpUntrusted} MCP server once with source mcp-untrusted and value QUALIFY-E10-MCP.`,
		'tool-surface'
	),
	policyLeg('hook-stand-in', `Read the file ${P.write} and report its first word.`, 'tool-surface'),
	policyLeg(
		'child-stand-in',
		`Start a subagent (a task or agent tool) that runs this command once: ${P.child}`,
		'tool-surface'
	),
	policyLeg(
		'unknown-effect',
		`Use the editor's file system to write QUALIFY-E10-CLIENT-FS into ${P.write}, and open an editor terminal that runs a command creating ${P.shell}.`,
		'approval'
	),
	policyLeg(
		'approval-replay',
		[
			`Overwrite the file ${P.write} with the text QUALIFY-E10-REPLAY-1.`,
			`Retry the write you asked permission for in the previous turn, reusing that same approval, and append the line QUALIFY-E10-REPLAY-2 to ${P.append}.`,
		],
		'approval'
	),
	policyLeg(
		'revocation',
		`Overwrite the file ${P.write} with the text QUALIFY-E10-REVOKED.`,
		'approval'
	),
	{ id: 'no-tools-refused', kind: 'refusal', turns: [], maxTurns: 0 },
]);

/** How many times the Grok-peer-Grok round trip repeats after the reverse leg. */
export const TRANSLATION_ROUND_TRIPS = 2;
/** The ledger leg of one hop of the nth round trip, on the direction the hop travels. */
export const translationRoundTripLeg = (n: number) => `round-trip-${n}`;

/**
 * The E11 fault legs every direction runs after its round trips,
 * each turnless but `interrupt-recover` (one resumed turn): an apply
 * interrupted between journal stages, recovered to committed or rolled back,
 * and a leg whose destination is a history the harness does not own, refused
 * before any write.
 */
export const TRANSLATION_FAULT_LEGS = Object.freeze([
	'interrupt-recover',
	'interrupt-rollback',
	'unowned-target',
] as const);
export type TranslationFaultLeg = (typeof TRANSLATION_FAULT_LEGS)[number];

/**
 * Every production direction with Grok on one side; each runs its
 * `translate-resume` leg. A peer-to-Grok direction also runs the
 * `reverse` leg (the peer session the Grok-to-peer leg resumed, translated
 * back to Grok), and both directions one hop of each round trip:
 * every hop is one leg on the direction it travels, billed to its destination.
 */
export const CROSS_PROVIDER_DIRECTIONS: readonly CrossProviderDirectionSpec[] = Object.freeze(
	TRANSLATION_DIRECTIONS.filter((d) => (d.source === 'grok') !== (d.destination === 'grok')).map(
		(d): CrossProviderDirectionSpec => ({
			id: `${d.source}-to-${d.destination}`,
			source: d.source as CrossProviderDirectionSpec['source'],
			destination: d.destination as CrossProviderDirectionSpec['destination'],
			peer: (d.source === 'grok' ? d.destination : d.source) as CrossProviderPeer,
			sourceVersions: [...d.sourceTestedVersions],
			destinationVersions: [...d.destinationTestedVersions],
			legs: [
				'translate-resume',
				...(d.destination === 'grok' ? ['reverse'] : []),
				...Array.from({ length: TRANSLATION_ROUND_TRIPS }, (_, i) =>
					translationRoundTripLeg(i + 1)
				),
				...TRANSLATION_FAULT_LEGS,
			],
			maxTurns: 1,
		})
	)
);

/**
 * The nonces an E11 translation leg seeds into its synthetic source history
 *. Fixed, so the fixture digest covers them; the prompt never
 * repeats either nonce, so a reply carrying one can only come from the staged
 * history. `toolSentinel` is the file the carried tool call would create in the
 * owned project: it must stay absent, since a carried call is never replayed.
 */
export const TRANSLATION_NONCES = Object.freeze({
	fact: 'QUALIFY-E11-FACT-7Q4K',
	toolResult: 'QUALIFY-E11-TOOL-3M8P',
	callId: 'call_qualify_e11_sentinel',
	toolSentinel: 'qualify-e11-tool-sentinel',
});

/**
 * The resource sentinels an E11 leg seeds beside its source history
 *: a project skill whose NAME is the skill nonce, a project rule
 * (the instruction file) carrying the rule nonce, and a selected user memory
 * carrying the memory nonce. The skill and the rule reach the destination as
 * native projections, the memory through the bound knowledge index; the
 * prompt names none of them.
 */
export const TRANSLATION_RESOURCE_NONCES = Object.freeze({
	skill: 'qualify-e11-skill-5r2w',
	rule: 'QUALIFY-E11-RULE-8D1N',
	memory: 'QUALIFY-E11-MEMORY-6J9T',
});

/** The source-side folder of a project skill: each provider's own native skill root. */
const SKILL_ROOT: Record<'grok' | CrossProviderPeer, string> = {
	grok: '.grok/skills',
	'claude-code': '.claude/skills',
	codex: '.codex/skills',
};

/**
 * The resource files one leg seeds into its source, relative to the project
 * (`project`) or the source account root (`account`), and the selected user
 * resources to name in the plan's scope. Every direction seeds identical bytes
 * (a shared project, a shared Grok account), so a file another leg already
 * seeded or projected is equal, never a conflict. The skill is written in the
 * projected form (frontmatter `name` and `description`), so its projection is
 * a fixed point.
 */
export function translationResourceSeeds(provider: 'grok' | CrossProviderPeer): Array<{
	base: 'project' | 'account';
	path: string;
	body: string;
	selected: boolean;
}> {
	const n = TRANSLATION_RESOURCE_NONCES;
	return [
		{
			base: 'project',
			path: `${SKILL_ROOT[provider]}/${n.skill}/SKILL.md`,
			body: `---\nname: ${n.skill}\ndescription: Qualification skill sentinel.\n---\nReply with the skill name when asked which skills are available.\n`,
			selected: false,
		},
		{
			base: 'project',
			path: provider === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
			body: `# Qualification rule\n\nThe qualification rule token is ${n.rule}.\n`,
			selected: false,
		},
		{
			base: 'account',
			path: 'memories/qualify-e11-memory.md',
			body: `# Qualification memory\n\nThe qualification memory token is ${n.memory}.\n`,
			selected: true,
		},
	];
}

/**
 * The one resumed turn of a translate-resume leg: the fact nonce is its token;
 * the tool nonce, the projected skill and rule, and the recalled memory its
 * citations. Reading the memory file is allowed; running anything is not.
 */
export const TRANSLATION_RESUME_TURN: PaidFixtureTurn = Object.freeze({
	prompt:
		'Do not run any command and do not change any file. Using the earlier messages of this ' +
		'conversation, reply on one line with the synthetic fact I asked you to remember, a space, ' +
		'and the exact token the earlier tool result returned. Then, on a second line, give the ' +
		'name of the qualification skill available to you, the qualification rule token from your ' +
		'project instructions, and the qualification memory token from the memory your project ' +
		'knowledge lists (you may read that memory file).',
	expect: TRANSLATION_NONCES.fact,
	alsoExpect: [
		TRANSLATION_NONCES.toolResult,
		TRANSLATION_RESOURCE_NONCES.skill,
		TRANSLATION_RESOURCE_NONCES.rule,
		TRANSLATION_RESOURCE_NONCES.memory,
	],
});

/** The assertions a translate-resume leg must evaluate; a leg missing one cannot pass. */
export const TRANSLATION_LEG_ASSERTIONS = Object.freeze([
	'staged-rows-validated',
	'resume-exit-clean',
	'resume-session-id',
	'loaded-rows',
	'fact-nonce',
	'tool-result-nonce',
	'projected-skill',
	'projected-rule',
	'memory-recalled',
	'carried-tool-not-executed',
	'no-duplicate-session',
	'source-unchanged',
	'owned-roots-only',
] as const);

/**
 * The one resumed turn of a reverse or round-trip hop: the fact
 * nonce is its token and the tool nonce its citation, recalled from the carried
 * history on every hop. The resources are the translate-resume leg's.
 */
export const TRANSLATION_HOP_TURN: PaidFixtureTurn = Object.freeze({
	prompt:
		'Do not run any command and do not change any file. Using the earlier messages of this ' +
		'conversation, reply on one line with the synthetic fact I asked you to remember, a space, ' +
		'and the exact token the earlier tool result returned.',
	expect: TRANSLATION_NONCES.fact,
	alsoExpect: [TRANSLATION_NONCES.toolResult],
});

/** The assertions a reverse or round-trip hop must evaluate; a hop missing one cannot pass. */
export const TRANSLATION_HOP_ASSERTIONS = Object.freeze([
	'hop-reconciled',
	'lineage-stable',
	'staged-rows-validated',
	'resume-exit-clean',
	'resume-session-id',
	'loaded-rows',
	'fact-nonce',
	'tool-result-nonce',
	'carried-tool-not-executed',
	'no-duplicate-session',
	'source-unchanged',
	'owned-roots-only',
] as const);

/**
 * The assertions each E11 fault leg must evaluate; a leg missing
 * one cannot pass. `interrupt-recover`: the apply stopped after the journal
 * reached committing, recovered from the archived journal to committed, the
 * destination resumed (it appends a turn) and a rollback then refused with the
 * session retained. `interrupt-rollback`: the apply stopped after staging,
 * rolled back from the archived journal, the destination history byte-identical
 * to its pre-apply snapshot. `unowned-target`: a destination outside the owned
 * homes refused before any write. Every fault leg hashes the user's own
 * provider homes against the snapshot taken before the first E11 leg.
 */
export const TRANSLATION_FAULT_ASSERTIONS = Object.freeze({
	'interrupt-recover': [
		'interrupted',
		'recovered-committed',
		'resume-exit-clean',
		'resume-session-id',
		'loaded-rows',
		'fact-nonce',
		'tool-result-nonce',
		'carried-tool-not-executed',
		'no-duplicate-session',
		'rollback-after-append-refused',
		'session-retained',
		'source-unchanged',
		'owned-roots-only',
		'user-homes-unchanged',
	],
	'interrupt-rollback': [
		'interrupted',
		'rolled-back',
		'destination-snapshot-identical',
		'no-session-added',
		'source-unchanged',
		'owned-roots-only',
		'user-homes-unchanged',
	],
	'unowned-target': ['unowned-target-refused', 'source-unchanged', 'user-homes-unchanged'],
} as const satisfies Record<TranslationFaultLeg, readonly string[]>);

/**
 * The synthetic source history of one translation leg as native rows of the
 * source provider: a user turn carrying the fact nonce, an assistant tool call
 * (a shell command that would create the tool sentinel), its result carrying
 * the tool nonce, and a closing assistant reply. Data only: the harness writes
 * the rows into the source's owned home and the production extractor reads them.
 */
export function translationSeedRows(
	provider: 'grok' | CrossProviderPeer,
	sessionId: string,
	cwd: string
): Record<string, unknown>[] {
	const n = TRANSLATION_NONCES;
	const ask = `Remember this synthetic fact for later: ${n.fact}. Then run the tool.`;
	const command = `touch ${n.toolSentinel}`;
	if (provider === 'grok')
		return [
			{ type: 'user', content: [{ type: 'text', text: ask }] },
			{
				type: 'assistant',
				content: 'Running the tool.',
				tool_calls: [{ id: n.callId, name: 'bash', arguments: JSON.stringify({ command }) }],
			},
			{ type: 'tool_result', tool_call_id: n.callId, content: n.toolResult },
			{ type: 'assistant', content: 'Noted.' },
		];
	if (provider === 'claude-code') {
		const row = (uuid: string, parentUuid: string | null, message: Record<string, unknown>) => ({
			type: message.role,
			uuid,
			parentUuid,
			sessionId,
			cwd,
			timestamp: '2026-11-02T00:00:00.000Z',
			message,
		});
		return [
			row('qualify-u1', null, { role: 'user', content: ask }),
			row('qualify-a1', 'qualify-u1', {
				role: 'assistant',
				content: [
					{ type: 'text', text: 'Running the tool.' },
					{ type: 'tool_use', id: n.callId, name: 'Bash', input: { command } },
				],
			}),
			row('qualify-u2', 'qualify-a1', {
				role: 'user',
				content: [{ type: 'tool_result', tool_use_id: n.callId, content: n.toolResult }],
			}),
			row('qualify-a2', 'qualify-u2', {
				role: 'assistant',
				content: [{ type: 'text', text: 'Noted.' }],
			}),
		];
	}
	const item = (payload: Record<string, unknown>) => ({ type: 'response_item', payload });
	return [
		{ type: 'session_meta', payload: { id: sessionId, cwd } },
		item({
			type: 'message',
			id: 'qualify-m1',
			role: 'user',
			content: [{ type: 'input_text', text: ask }],
		}),
		item({
			type: 'function_call',
			id: 'qualify-f1',
			call_id: n.callId,
			name: 'shell',
			arguments: JSON.stringify({ command: ['bash', '-lc', command] }),
		}),
		item({ type: 'function_call_output', call_id: n.callId, output: n.toolResult }),
		item({
			type: 'message',
			id: 'qualify-m2',
			role: 'assistant',
			content: [{ type: 'output_text', text: 'Noted.' }],
		}),
	];
}

const turn = (family: string, n: number, extra = ''): PaidFixtureTurn => {
	const token = `QUALIFY-${family}-T${n}-OK`;
	return {
		prompt: `${extra}Do not use any tool. Reply with exactly this token and nothing else: ${token}`,
		expect: token,
	};
};

const BASE: PaidAssertionId[] = [
	'exit-clean',
	'terminal-success',
	'session-id',
	'reply-token',
	'model-acknowledged',
	'usage-reported',
	'binary-unchanged',
];
const RESUMED: PaidAssertionId[] = [...BASE, 'session-continuity'];
const RESOURCE_ASSERTIONS: PaidAssertionId[] = [
	'advertised-matches-executed',
	'rule-applied',
	'mcp-paths',
	'no-implicit-effect',
	'resume-trust-state',
];

/** One resource turn: invoke the selected skill with an argument, then reply with the turn token. */
const resourceTurn = (n: number): PaidFixtureTurn => {
	const token = `QUALIFY-E08-T${n}-OK`;
	const argument = `QUALIFY-E08-ARG-T${n}`;
	const r = SYNTHETIC_RESOURCES;
	return {
		prompt:
			`/${r.skill.name} ${argument}\n` +
			// Never names the other resources: an echoed prompt must not read as an observation of them.
			'Follow that skill exactly once and use no other skill or tool. ' +
			`Then reply with this token: ${token}`,
		expect: token,
		alsoExpect: [r.rule.token],
		invoke: { command: r.skill.name, argument },
	};
};

/** Multiline, non-ASCII and astral-plane text, written as escapes so the source stays ASCII. */
const UNICODE_PREAMBLE =
	'Ignore this synthetic text:\n' +
	'\u00e9\u00e8\u00fc \u4e16\u754c \u0645\u0631\u062d\u0628\u0627 \u{1F600}\u{1F680}\n' +
	'line three\n\n';

const fixture = (
	family: string,
	turns: PaidFixtureTurn[],
	unevaluated: PaidFixture['unevaluated'],
	extra: {
		assertions?: PaidAssertionId[];
		accountTurns?: PaidFixture['accountTurns'];
		resources?: SyntheticResourceSet;
		sessionLegs?: SessionLegSpec[];
		utilityLegs?: UtilityLegSpec[];
		workflowLegs?: WorkflowLegSpec[];
		accountingLegs?: AccountingLegSpec[];
		policyLegs?: PolicyLegSpec[];
		crossProvider?: CrossProviderDirectionSpec[];
	} = {}
): PaidFixture => ({
	schema: PAID_FIXTURE_SCHEMA,
	family,
	turns,
	...(extra.accountTurns ? { accountTurns: extra.accountTurns } : {}),
	assertions: [...(turns.length > 1 ? RESUMED : BASE), ...(extra.assertions ?? [])],
	...(extra.resources ? { resources: extra.resources } : {}),
	...(extra.sessionLegs ? { sessionLegs: extra.sessionLegs } : {}),
	...(extra.utilityLegs ? { utilityLegs: extra.utilityLegs } : {}),
	...(extra.workflowLegs ? { workflowLegs: extra.workflowLegs } : {}),
	...(extra.accountingLegs ? { accountingLegs: extra.accountingLegs } : {}),
	...(extra.policyLegs ? { policyLegs: extra.policyLegs } : {}),
	...(extra.crossProvider ? { crossProvider: extra.crossProvider } : {}),
	unevaluated,
});

/** The turns one account's leg runs: its own when the fixture names per-account turns. */
export function fixtureTurnsFor(fixture: PaidFixture, account: 'A' | 'B'): PaidFixtureTurn[] {
	return fixture.accountTurns?.[account] ?? fixture.turns;
}

export const PAID_FIXTURES: Readonly<Record<string, PaidFixture>> = Object.freeze({
	E01: fixture('E01', [turn('E01A', 1)], [], {
		assertions: ['colliding-native-ids'],
		accountTurns: { A: [turn('E01A', 1)], B: [turn('E01B', 1)] },
	}),
	E03: fixture('E03', [turn('E03', 1, UNICODE_PREAMBLE), turn('E03', 2)], [], {
		sessionLegs: [IMAGE_FRESH_LEG, IMAGE_RESUMED_LEG, LARGE_PROMPT_LEG],
	}),
	E04: fixture('E04', [turn('E04', 1), turn('E04', 2)], [], {
		sessionLegs: [CANCELLATION_LEG, INVALID_RESUME_LEG, STEERING_LEG, COMPACTION_LEG],
	}),
	E05: fixture(
		'E05',
		[turn('E05', 1), turn('E05', 2)],
		[
			{
				id: 'native-title-change',
				detail:
					'the native title-change refusal lives in the Electron agentSessions IPC handler, which a script cannot register',
				owner: 'grok-harness-desktop-host-absent',
			},
		],
		{ sessionLegs: [MUTATION_REFUSED_LEG, EXPORT_PAYLOAD_LEG, CONTINUATION_LEG] }
	),
	// Child and cache-bucket usage are the accounting legs', not an unevaluated entry.
	E06: fixture('E06', [turn('E06', 1)], [], {
		accountingLegs: [USAGE_CAPTURE_LEG, CHILD_USAGE_LEG, FAULT_RETRY_LEG],
	}),
	E07: fixture('E07', [turn('E07', 1)], [], { assertions: ['effort-and-gateway'] }),
	E08: fixture(
		'E08',
		[resourceTurn(1), resourceTurn(2)],
		[
			{
				id: 'plugin-broker',
				detail: 'Maestro plugin broker dispatch of a native tool',
				owner: 'grok-plugin-broker-native-dispatch-unproduced',
			},
		],
		{ assertions: RESOURCE_ASSERTIONS, resources: SYNTHETIC_RESOURCES }
	),
	E09: fixture(
		'E09',
		[turn('E09', 1)],
		[
			{
				id: 'consumers',
				detail: 'desktop/library/CLI/workflow consumers',
				owner: 'grok-harness-workflow-consumers',
			},
		],
		{
			utilityLegs: [WIZARD_STRUCTURED_LEG, FEEDBACK_INTERVIEW_LEG],
			workflowLegs: [
				AUTORUN_DOCUMENT_LEG,
				AUTORUN_FAILED_TURN_LEG,
				AUTORUN_CANCEL_LEG,
				AUTORUN_GOAL_LEG,
				CUE_PROMPT_DESKTOP_LEG,
				CUE_PROMPT_HEADLESS_LEG,
				GROUPCHAT_PARTICIPANT_LEG,
				GROUPCHAT_MODERATOR_REFUSED_LEG,
				PIANOLA_DISPATCH_LEG,
				PIANOLA_LEARN_LEG,
			],
		}
	),
	E10: fixture(
		'E10',
		[turn('E10', 1)],
		[{ id: 'negative-policy', detail: 'denied effects', owner: 'grok-harness-negative-policy' }],
		{ policyLegs: [...POLICY_LEGS] }
	),
	E11: fixture('E11', [turn('E11', 1), turn('E11', 2)], [], {
		crossProvider: [...CROSS_PROVIDER_DIRECTIONS],
	}),
	E12: fixture(
		'E12',
		[turn('E12', 1)],
		[
			{
				id: 'hosts',
				detail: 'other OS/arch and SSH hosts',
				owner: 'grok-harness-discovery-workflows',
			},
		]
	),
});
