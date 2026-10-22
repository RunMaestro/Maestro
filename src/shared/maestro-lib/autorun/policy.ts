/**
 * What differs between the surfaces that run the Auto Run engine, as data.
 *
 * A rule is a policy only where the surfaces differ for a reason: one has a person to wait for
 * and the other does not, or the CLI has an output contract a script depends on
 * (`Plans/maestro-tui-autorun-engine.md`, AE4). The engine reads a policy; it never asks which
 * surface it is on. Only the branches the engine implements so far are here. The one still in the
 * design is `reset` (a working copy per loop, AE21): the runtime resets in place, as the CLI does,
 * until that lands.
 */

import { resolveAutoResumePolicy, type AutoResumePolicy } from '../../autorunAutoResume';

export interface AutoRunPolicy {
	/**
	 * A HITL gate asks for a person. `skip-document` reports it and moves on (a batch run has
	 * nobody to wait for). `pause` parks the run until the gate is answered. `pause` needs a
	 * controller: without one the engine falls back to `skip-document`.
	 */
	onGate: 'skip-document' | 'pause';
	/**
	 * A turn that ends in a classified agent error. `continue` records the failed task and goes on
	 * (the CLI today). `pause` parks the run until resume, skip, or abort. Also needs a controller.
	 */
	onAgentError: 'continue' | 'pause';
	/**
	 * Fallback auto-resume for an error pause. Never a gate, never a limit error: a limit wants an
	 * hour-scale probe, and a few five-minute tries would spend the attempts and fail (AE9). The
	 * controller reads this, not the engine.
	 */
	autoResume: AutoResumePolicy | null;
	/**
	 * Where a task's History line comes from. `resume-turn` asks the agent for one in a second,
	 * cheap turn (the CLI's contract, and `--no-synopsis` turns it off). `from-response` reads the
	 * first paragraph of the task's own answer, one turn fewer per task (the desktop, AE15).
	 * `none` writes the plain `Task completed` line.
	 */
	synopsis: 'resume-turn' | 'from-response' | 'none';
	/**
	 * Append `# Current Document` and the document's text to every task prompt. The desktop's
	 * prompt names `{{DOCUMENT_PATH}}` and lets the agent read the file (AE22).
	 */
	inlineDocument: boolean;
	/**
	 * Commit the working tree after each goal iteration so every increment is recoverable (AE23).
	 * Best effort, and a port: a surface with no `environment.commitAll` never commits.
	 */
	checkpointCommits: boolean;
}

/** `maestro-cli run-playbook`, `run-doc`, `goal-run`: no person, so nothing ever waits. */
export const CLI_AUTORUN_POLICY: AutoRunPolicy = {
	onGate: 'skip-document',
	onAgentError: 'continue',
	autoResume: null,
	synopsis: 'resume-turn',
	inlineDocument: true,
	checkpointCommits: false,
};

/**
 * The desktop's behavior, and the runtime's: the TUI attached to either host must see the same
 * run (req-D2). A person may be watching, so the run waits for them, and falls back to a timed
 * resume when nobody answers an error.
 */
export const DESKTOP_AUTORUN_POLICY: AutoRunPolicy = {
	onGate: 'pause',
	onAgentError: 'pause',
	autoResume: resolveAutoResumePolicy(),
	synopsis: 'from-response',
	inlineDocument: false,
	checkpointCommits: true,
};
