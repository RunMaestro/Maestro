export type LlmGuardAction = 'warn' | 'sanitize' | 'block';

export interface LlmGuardConfig {
	enabled: boolean;
	action: LlmGuardAction;
	input: {
		anonymizePii: boolean;
		redactSecrets: boolean;
		detectPromptInjection: boolean;
	};
	output: {
		deanonymizePii: boolean;
		redactSecrets: boolean;
		detectPiiLeakage: boolean;
	};
	thresholds: {
		promptInjection: number;
	};
}

export interface LlmGuardFinding {
	type: string;
	value: string;
	start: number;
	end: number;
	confidence: number;
	replacement?: string;
}

export interface LlmGuardVaultEntry {
	placeholder: string;
	original: string;
	type: string;
}

export interface LlmGuardVaultSnapshot {
	entries: LlmGuardVaultEntry[];
}

export interface LlmGuardState {
	config: LlmGuardConfig;
	vault: LlmGuardVaultSnapshot;
	inputFindings: LlmGuardFinding[];
}

export interface LlmGuardPreResult {
	sanitizedPrompt: string;
	vault: LlmGuardVaultSnapshot;
	findings: LlmGuardFinding[];
	blocked: boolean;
	blockReason?: string;
}

export interface LlmGuardPostResult {
	sanitizedResponse: string;
	findings: LlmGuardFinding[];
	blocked: boolean;
	blockReason?: string;
}
