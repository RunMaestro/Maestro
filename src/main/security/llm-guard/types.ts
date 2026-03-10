export type LlmGuardAction = 'warn' | 'sanitize' | 'block';

/**
 * Custom pattern type for user-defined security rules.
 * Patterns are regex strings that can detect specific content types.
 */
export type CustomPatternType = 'secret' | 'pii' | 'injection' | 'other';

/**
 * Custom regex pattern for user-defined security scanning.
 * Users can define their own patterns to detect specific content.
 */
export interface CustomPattern {
	/** Unique identifier for the pattern */
	id: string;
	/** Human-readable name for the pattern */
	name: string;
	/** Regex pattern string (will be compiled with 'gi' flags) */
	pattern: string;
	/** Type of content this pattern detects */
	type: CustomPatternType;
	/** Action to take when pattern matches */
	action: LlmGuardAction;
	/** Confidence score for matches (0.0 - 1.0) */
	confidence: number;
	/** Whether pattern is enabled */
	enabled: boolean;
	/** Optional description */
	description?: string;
}

export interface LlmGuardConfig {
	enabled: boolean;
	action: LlmGuardAction;
	input: {
		anonymizePii: boolean;
		redactSecrets: boolean;
		detectPromptInjection: boolean;
		/** Enable structural prompt injection analysis (default: true) */
		structuralAnalysis?: boolean;
		/** Enable invisible character detection (default: true) */
		invisibleCharacterDetection?: boolean;
		/** Enable malicious URL detection (default: true) */
		scanUrls?: boolean;
	};
	output: {
		deanonymizePii: boolean;
		redactSecrets: boolean;
		detectPiiLeakage: boolean;
		/** Enable output injection detection (default: true) */
		detectOutputInjection?: boolean;
		/** Enable malicious URL detection in outputs (default: true) */
		scanUrls?: boolean;
		/** Enable dangerous code pattern detection (default: true) */
		scanCode?: boolean;
	};
	thresholds: {
		promptInjection: number;
	};
	/** Exact substring matches that should be blocked (case-insensitive) */
	banSubstrings?: string[];
	/** Regex patterns for banned topics (case-insensitive) */
	banTopicsPatterns?: string[];
	/** Custom regex patterns defined by the user */
	customPatterns?: CustomPattern[];
	/** Group Chat inter-agent protection settings */
	groupChat?: {
		/** Enable inter-agent scanning in Group Chat (default: true) */
		interAgentScanEnabled?: boolean;
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
	warned: boolean;
	warningReason?: string;
}

export interface LlmGuardPostResult {
	sanitizedResponse: string;
	findings: LlmGuardFinding[];
	blocked: boolean;
	blockReason?: string;
	warned: boolean;
	warningReason?: string;
}

/**
 * Result of structural prompt injection analysis.
 * Analyzes structural patterns in text that may indicate prompt injection attempts.
 */
export interface StructuralAnalysisResult {
	/** Overall score from 0-1 indicating likelihood of structural injection */
	score: number;
	/** Individual structural issues found */
	issues: StructuralIssue[];
	/** Combined findings from structural analysis */
	findings: LlmGuardFinding[];
}

/**
 * Individual structural issue detected during analysis.
 */
export interface StructuralIssue {
	/** Type of structural issue */
	type:
		| 'MULTIPLE_SYSTEM_SECTIONS'
		| 'JSON_PROMPT_TEMPLATE'
		| 'XML_PROMPT_TEMPLATE'
		| 'MARKDOWN_SYSTEM_HEADER'
		| 'BASE64_BLOCK';
	/** Description of the issue */
	description: string;
	/** Severity weight (0-1) */
	severity: number;
	/** Start position in text */
	start: number;
	/** End position in text */
	end: number;
	/** Matched text */
	value: string;
}

/**
 * Result of output injection detection.
 * Analyzes LLM responses for patterns that could inject malicious content
 * into the user's next prompt.
 */
export interface OutputInjectionResult {
	/** Array of findings for detected output injection patterns */
	findings: LlmGuardFinding[];
	/** Whether output injection was detected */
	hasInjection: boolean;
	/** Overall confidence score (highest finding confidence) */
	highestConfidence: number;
}

/**
 * Result of inter-agent security scanning in Group Chat.
 * Applied when one agent's output is being passed as input to another agent.
 */
export interface LlmGuardInterAgentResult {
	/** The sanitized message after scanning */
	sanitizedMessage: string;
	/** Findings from the scan */
	findings: LlmGuardFinding[];
	/** Whether the message was blocked */
	blocked: boolean;
	/** Reason for blocking */
	blockReason?: string;
	/** Whether warnings were generated */
	warned: boolean;
	/** Warning reason */
	warningReason?: string;
	/** Source agent name (whose output is being scanned) */
	sourceAgent: string;
	/** Target agent name (who will receive the message) */
	targetAgent: string;
}
