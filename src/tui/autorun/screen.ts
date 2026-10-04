import type { LaunchFormState } from './launchForm';

/**
 * The screens of the Auto Run overlay that sit over the document list. Esc
 * puts the screen away and shows the list again; the list itself is the
 * overlay's `view` and is never lost.
 */
export type RunScreen =
	| { kind: 'launch'; form: LaunchFormState; submitting: boolean; error?: string }
	| {
			kind: 'progress';
			agentId: string;
			/** A control in flight: what it is doing, for one line. */
			busy?: string;
			/** The answer to the last control. */
			message?: string;
			error?: string;
	  };
