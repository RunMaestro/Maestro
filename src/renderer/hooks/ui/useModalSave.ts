import { useCallback, useState } from 'react';
import type { ModalSaveOutcome } from '../../types';
import { ipcErrorMessage } from '../../../shared/serializeError';
import { captureException } from '../../utils/sentry';

/**
 * The save of a modal that sends what the person typed somewhere that can refuse it (a hosted
 * agent's host): Edit Queued Message and Rename Tab. `save()` waits for the answer and closes the
 * modal only on `saved`; otherwise the modal stays open with the person's input and `saveError`
 * holds the reason to show in it. The same in every mode: a local save answers at once.
 *
 * A save that throws is a bug, not a refusal: it is reported, and its message is shown so the
 * person still has their input and knows it did not land.
 */
export function useModalSave(
	onSave: () => Promise<ModalSaveOutcome>,
	onClose: () => void,
	component: string
): {
	save: () => Promise<void>;
	saving: boolean;
	saveError: string | null;
	clearSaveError: () => void;
} {
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);

	const save = useCallback(async () => {
		if (saving) return;
		setSaving(true);
		setSaveError(null);
		let outcome: ModalSaveOutcome;
		try {
			outcome = await onSave();
		} catch (error) {
			captureException(error, { extra: { component, action: 'save' } });
			outcome = { saved: false, reason: ipcErrorMessage(error, 'It was not saved.') };
		}
		setSaving(false);
		if (outcome.saved) onClose();
		else setSaveError(outcome.reason);
	}, [saving, onSave, onClose, component]);

	const clearSaveError = useCallback(() => setSaveError(null), []);

	return { save, saving, saveError, clearSaveError };
}
