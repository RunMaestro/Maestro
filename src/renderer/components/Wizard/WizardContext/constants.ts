import type { WizardStep } from './types';

export const WIZARD_TOTAL_STEPS = 5;

export const STEP_INDEX: Record<WizardStep, number> = {
	'agent-selection': 1,
	'directory-selection': 2,
	conversation: 3,
	'preparing-plan': 4,
	'phase-review': 5,
};

export const INDEX_TO_STEP: Record<number, WizardStep> = {
	1: 'agent-selection',
	2: 'directory-selection',
	3: 'conversation',
	4: 'preparing-plan',
	5: 'phase-review',
};
