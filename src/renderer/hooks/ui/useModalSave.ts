import { useCallback, useRef, useState } from 'react';
import type { ModalSaveOutcome } from '../../types';
import { ipcErrorMessage } from '../../../shared/serializeError';
import { captureException } from '../../utils/sentry';

/** Why a modal stayed open after a save that landed: the person changed the input meanwhile. */
export const MODAL_SAVE_CHANGED_REASON =
	'the changes you made while it was saving. Save again to keep them.';

/** Whether any input value is a different value than when the save was sent. */
function draftChanged(submitted: readonly unknown[], current: readonly unknown[]): boolean {
	return (
		submitted.length !== current.length ||
		submitted.some((value, i) => !Object.is(value, current[i]))
	);
}

/**
 * The save of a modal that sends what the person typed somewhere that can refuse it (a hosted
 * agent's host): Edit Queued Message and Rename Tab. `save()` waits for the answer and closes the
 * modal only on `saved`; otherwise the modal stays open with the person's input and `saveError`
 * holds the reason to show in it. The same in every mode: a local save answers at once.
 *
 * A save that throws is a bug, not a refusal: it is reported, and its message is shown so the
 * person still has their input and knows it did not land.
 *
 * `draft` lists the modal's input values (the state the person edits). The input stays editable
 * while a host answers, so a save that lands after the person changed one of them saved only the
 * earlier input: the modal then stays open with the later input and says so
 * (`MODAL_SAVE_CHANGED_REASON`), instead of closing on it.
 */
export function useModalSave(
	onSave: () => Promise<ModalSaveOutcome>,
	onClose: () => void,
	component: string,
	draft: readonly unknown[]
): {
	save: () => Promise<void>;
	saving: boolean;
	saveError: string | null;
	clearSaveError: () => void;
} {
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const latestDraft = useRef(draft);
	latestDraft.current = draft;

	const save = useCallback(async () => {
		if (saving) return;
		setSaving(true);
		setSaveError(null);
		const submitted = latestDraft.current;
		let outcome: ModalSaveOutcome;
		try {
			outcome = await onSave();
		} catch (error) {
			captureException(error, { extra: { component, action: 'save' } });
			outcome = { saved: false, reason: ipcErrorMessage(error, 'It was not saved.') };
		}
		setSaving(false);
		if (!outcome.saved) setSaveError(outcome.reason);
		else if (draftChanged(submitted, latestDraft.current)) setSaveError(MODAL_SAVE_CHANGED_REASON);
		else onClose();
	}, [saving, onSave, onClose, component]);

	const clearSaveError = useCallback(() => setSaveError(null), []);

	return { save, saving, saveError, clearSaveError };
}
