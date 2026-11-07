/**
 * secretScreen - the one "Publish anyway?" flow for content the secret screen
 * refused.
 *
 * The screen itself runs in the main process, at the point each publishing
 * path converges (see `src/main/local-models/secret-screen.ts`). It answers a
 * refusal with masked findings. Three surfaces can receive one: the Publish
 * Gist modal, the Feedback chat, and Create Debug Package. All three route
 * through {@link withSecretScreenConfirm}, so the dialog, its wording, and what
 * a yes does cannot drift between them.
 *
 * A yes repeats the SAME request with `allowSecrets: true`. Nothing is edited on
 * the user's behalf: removing the secret is their call, and Cancel leaves the
 * content where it was.
 */

import { useSecretScreenStore } from '../stores/secretScreenStore';
import { generateId } from '../utils/ids';
import {
	isSecretScreenRefusal,
	type SecretFinding,
	type SecretScreenFields,
} from '../../shared/secretScan';

export interface SecretScreenPrompt {
	/** What would be sent, as it reads in a sentence: "this gist". */
	subject: string;
	/** Defaults to "Publish anyway". */
	confirmLabel?: string;
}

/**
 * Ask whether to send content the screen flagged. Resolves true on the confirm
 * button and false on Cancel, Escape, or closing the dialog.
 */
export function confirmSecretFindings(
	findings: SecretFinding[],
	prompt: SecretScreenPrompt & { note?: string }
): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	useSecretScreenStore.setState((s) => ({
		queue: [
			...s.queue,
			{
				id: generateId(),
				subject: prompt.subject,
				findings,
				note: prompt.note,
				confirmLabel: prompt.confirmLabel ?? 'Publish anyway',
				resolve,
			},
		],
	}));
	return promise;
}

export interface SecretScreenOutcome<T> {
	/** The last answer from the publishing path. A refusal when `declined`. */
	result: T;
	/** The screen refused and the user chose Cancel. Nothing was sent. */
	declined: boolean;
}

/**
 * Run a publishing request through the secret screen's confirmation.
 *
 * `attempt(false)` goes first. If it comes back refused, the user is asked; a
 * yes runs `attempt(true)` and a no returns the refusal with `declined` set, so
 * the caller can go quiet instead of showing "possible secrets found" as an
 * error the user just dismissed.
 */
export async function withSecretScreenConfirm<T extends SecretScreenFields>(
	attempt: (allowSecrets: boolean) => Promise<T>,
	prompt: SecretScreenPrompt
): Promise<SecretScreenOutcome<T>> {
	const first = await attempt(false);
	if (!isSecretScreenRefusal(first)) return { result: first, declined: false };

	const proceed = await confirmSecretFindings(first.secretFindings, {
		...prompt,
		note: first.secretScreenNote,
	});
	if (!proceed) return { result: first, declined: true };
	return { result: await attempt(true), declined: false };
}
