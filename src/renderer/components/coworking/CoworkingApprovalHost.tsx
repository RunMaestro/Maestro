/**
 * Renders the front of the coworking browser-interaction approval queue as a
 * confirm dialog. Confirm settles the awaiting op true; close/cancel settles it
 * false (so a cancelled approval never hangs the agent's tool call).
 */

import { ConfirmModal } from '../ConfirmModal';
import type { Theme } from '../../types';
import { useCoworkingApprovalStore } from '../../stores/coworkingApprovalStore';

export function CoworkingApprovalHost({ theme }: { theme: Theme }) {
	const front = useCoworkingApprovalStore((s) => s.queue[0]);
	const settle = useCoworkingApprovalStore((s) => s.settle);
	if (!front) return null;
	return (
		<ConfirmModal
			theme={theme}
			title={front.title}
			message={front.message}
			destructive
			confirmLabel="Allow"
			onConfirm={() => settle(front.id, true)}
			onClose={() => settle(front.id, false)}
		/>
	);
}
