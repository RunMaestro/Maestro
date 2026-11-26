import type { Theme } from '../../types';

/**
 * Why a modal's save did not land, shown in the modal under the person's input (`useModalSave()`).
 * Renders nothing while there is no reason.
 */
export function ModalSaveError({ theme, reason }: { theme: Theme; reason: string | null }) {
	if (!reason) return null;
	return (
		<div
			className="mt-2 text-xs select-text"
			style={{ color: theme.colors.error }}
			role="alert"
			data-testid="modal-save-error"
		>
			Not saved: {reason}
		</div>
	);
}
