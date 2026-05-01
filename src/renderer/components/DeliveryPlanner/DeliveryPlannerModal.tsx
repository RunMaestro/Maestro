/**
 * DeliveryPlannerModal
 *
 * Thin modal shell wrapping PlannerShell.
 * PlannerShell already renders its own portal + layer stack internally,
 * so this component simply passes through to it when open.
 */

import type { Theme, Session } from '../../types';
import { PlannerShell } from './PlannerShell';

export interface DeliveryPlannerModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	activeSession?: Session | null;
}

export function DeliveryPlannerModal({
	theme,
	isOpen,
	onClose,
	activeSession,
}: DeliveryPlannerModalProps) {
	return (
		<PlannerShell theme={theme} isOpen={isOpen} onClose={onClose} activeSession={activeSession} />
	);
}
