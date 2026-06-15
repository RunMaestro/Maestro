import { INDEX_TO_STEP, STEP_INDEX, WIZARD_TOTAL_STEPS } from './constants';
import type { WizardStep } from './types';

export function getNextStep(current: WizardStep): WizardStep | null {
	const currentIndex = STEP_INDEX[current];
	const nextIndex = currentIndex + 1;
	return nextIndex <= WIZARD_TOTAL_STEPS ? INDEX_TO_STEP[nextIndex] : null;
}

export function getPreviousStep(current: WizardStep): WizardStep | null {
	const currentIndex = STEP_INDEX[current];
	const prevIndex = currentIndex - 1;
	return prevIndex >= 1 ? INDEX_TO_STEP[prevIndex] : null;
}
