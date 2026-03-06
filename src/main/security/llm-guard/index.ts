import { PiiVault } from './vault';
import type {
	LlmGuardConfig,
	LlmGuardFinding,
	LlmGuardPostResult,
	LlmGuardPreResult,
	LlmGuardVaultSnapshot,
} from './types';

const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?){2}\d{4}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const IPV4_REGEX = /\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

const SECRET_PATTERNS = [
	{
		type: 'SECRET_GITHUB_TOKEN',
		regex: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9_]{36,}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_GITHUB_PAT',
		regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
		confidence: 0.99,
	},
	{
		type: 'SECRET_AWS_ACCESS_KEY',
		regex: /\bAKIA[0-9A-Z]{16}\b/g,
		confidence: 0.98,
	},
	{
		type: 'SECRET_OPENAI_KEY',
		regex: /\bsk-[A-Za-z0-9]{20,}\b/g,
		confidence: 0.96,
	},
	{
		type: 'SECRET_CONNECTION_STRING',
		regex: /\b(?:postgres|mysql|mongodb):\/\/[^\s'"]+/g,
		confidence: 0.95,
	},
];

const PROMPT_INJECTION_PATTERNS = [
	{
		type: 'PROMPT_INJECTION_IGNORE_INSTRUCTIONS',
		regex: /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|prompts?|context)/gi,
		confidence: 0.98,
	},
	{
		type: 'PROMPT_INJECTION_SYSTEM_PROMPT',
		regex: /(?:reveal|show|print|dump)\s+(?:the\s+)?system\s+prompt/gi,
		confidence: 0.93,
	},
	{
		type: 'PROMPT_INJECTION_ROLE_OVERRIDE',
		regex: /you\s+are\s+now\s+(?:a|an)?/gi,
		confidence: 0.84,
	},
	{
		type: 'PROMPT_INJECTION_NEW_INSTRUCTIONS',
		regex: /\bnew\s+instructions?\s*:/gi,
		confidence: 0.78,
	},
];

export const DEFAULT_LLM_GUARD_CONFIG: LlmGuardConfig = {
	enabled: false,
	action: 'sanitize',
	input: {
		anonymizePii: true,
		redactSecrets: true,
		detectPromptInjection: true,
	},
	output: {
		deanonymizePii: true,
		redactSecrets: true,
		detectPiiLeakage: true,
	},
	thresholds: {
		promptInjection: 0.7,
	},
};

export function normalizeLlmGuardConfig(config?: Partial<LlmGuardConfig> | null): LlmGuardConfig {
	return {
		...DEFAULT_LLM_GUARD_CONFIG,
		...config,
		input: {
			...DEFAULT_LLM_GUARD_CONFIG.input,
			...(config?.input || {}),
		},
		output: {
			...DEFAULT_LLM_GUARD_CONFIG.output,
			...(config?.output || {}),
		},
		thresholds: {
			...DEFAULT_LLM_GUARD_CONFIG.thresholds,
			...(config?.thresholds || {}),
		},
	};
}

export function runLlmGuardPre(prompt: string, config?: Partial<LlmGuardConfig> | null): LlmGuardPreResult {
	const effectiveConfig = normalizeLlmGuardConfig(config);
	if (!effectiveConfig.enabled) {
		return {
			sanitizedPrompt: prompt,
			vault: { entries: [] },
			findings: [],
			blocked: false,
		};
	}

	let sanitizedPrompt = prompt;
	const findings: LlmGuardFinding[] = [];

	if (effectiveConfig.input.redactSecrets) {
		const secretScan = redactSecrets(sanitizedPrompt);
		sanitizedPrompt = secretScan.text;
		findings.push(...secretScan.findings);
	}

	const vault = new PiiVault();
	if (effectiveConfig.input.anonymizePii) {
		const piiScan = anonymizePii(sanitizedPrompt, vault);
		sanitizedPrompt = piiScan.text;
		findings.push(...piiScan.findings);
	}

	let blocked = false;
	let blockReason: string | undefined;

	if (effectiveConfig.input.detectPromptInjection) {
		const promptInjectionFindings = detectPromptInjection(prompt);
		findings.push(...promptInjectionFindings);

		const highestScore = promptInjectionFindings.reduce(
			(maxScore, finding) => Math.max(maxScore, finding.confidence),
			0
		);
		if (
			effectiveConfig.action === 'block' &&
			highestScore >= effectiveConfig.thresholds.promptInjection
		) {
			blocked = true;
			blockReason = 'Prompt blocked by LLM Guard due to prompt injection signals.';
		}
	}

	return {
		sanitizedPrompt,
		vault: vault.toJSON(),
		findings,
		blocked,
		blockReason,
	};
}

export function runLlmGuardPost(
	response: string,
	vault: LlmGuardVaultSnapshot | undefined,
	config?: Partial<LlmGuardConfig> | null
): LlmGuardPostResult {
	const effectiveConfig = normalizeLlmGuardConfig(config);
	if (!effectiveConfig.enabled) {
		return {
			sanitizedResponse: response,
			findings: [],
			blocked: false,
		};
	}

	let sanitizedResponse =
		effectiveConfig.output.deanonymizePii ? PiiVault.deanonymize(response, vault) : response;
	const findings: LlmGuardFinding[] = [];

	if (effectiveConfig.output.redactSecrets) {
		const secretScan = redactSecrets(sanitizedResponse);
		sanitizedResponse = secretScan.text;
		findings.push(...secretScan.findings);
	}

	if (effectiveConfig.output.detectPiiLeakage) {
		const piiLeakageFindings = detectPiiLeakage(sanitizedResponse, vault);
		findings.push(...piiLeakageFindings);
	}

	const blocked =
		effectiveConfig.action === 'block' &&
		findings.some((finding) => finding.type.startsWith('SECRET_') || finding.type.startsWith('PII_'));

	return {
		sanitizedResponse,
		findings,
		blocked,
		blockReason: blocked ? 'Response blocked by LLM Guard due to sensitive content.' : undefined,
	};
}

function collectMatches(regex: RegExp, text: string, type: string, confidence: number): LlmGuardFinding[] {
	const findings: LlmGuardFinding[] = [];
	const matcher = new RegExp(regex.source, regex.flags);
	let match: RegExpExecArray | null;

	while ((match = matcher.exec(text)) !== null) {
		const value = match[0];
		findings.push({
			type,
			value,
			start: match.index,
			end: match.index + value.length,
			confidence,
		});
	}

	return findings;
}

function applyReplacements(
	text: string,
	findings: LlmGuardFinding[],
	replacementBuilder: (finding: LlmGuardFinding, index: number) => string
): { text: string; findings: LlmGuardFinding[] } {
	const sortedFindings = [...findings].sort((a, b) => b.start - a.start);
	let nextText = text;

	sortedFindings.forEach((finding, reverseIndex) => {
		const index = sortedFindings.length - reverseIndex;
		const replacement = replacementBuilder(finding, index);
		nextText =
			nextText.slice(0, finding.start) + replacement + nextText.slice(finding.end);
		finding.replacement = replacement;
	});

	return {
		text: nextText,
		findings: sortedFindings.sort((a, b) => a.start - b.start),
	};
}

function redactSecrets(text: string): { text: string; findings: LlmGuardFinding[] } {
	const findings = SECRET_PATTERNS.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	);

	if (!findings.length) {
		return { text, findings: [] };
	}

	return applyReplacements(text, findings, (finding, index) => `[REDACTED_${finding.type}_${index}]`);
}

function anonymizePii(text: string, vault: PiiVault): { text: string; findings: LlmGuardFinding[] } {
	const piiPatterns = [
		{ type: 'PII_EMAIL', regex: EMAIL_REGEX, confidence: 0.99 },
		{ type: 'PII_PHONE', regex: PHONE_REGEX, confidence: 0.92 },
		{ type: 'PII_SSN', regex: SSN_REGEX, confidence: 0.97 },
		{ type: 'PII_IP_ADDRESS', regex: IPV4_REGEX, confidence: 0.88 },
		{ type: 'PII_CREDIT_CARD', regex: CREDIT_CARD_REGEX, confidence: 0.75 },
	];

	const findings = piiPatterns.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	).filter((finding) => {
		if (finding.type !== 'PII_CREDIT_CARD') return true;
		return passesLuhnCheck(finding.value.replace(/[ -]/g, ''));
	});

	if (!findings.length) {
		return { text, findings: [] };
	}

	return applyReplacements(text, findings, (finding, index) => {
		const placeholder = `[${finding.type.replace('PII_', '')}_${index}]`;
		vault.add({
			placeholder,
			original: finding.value,
			type: finding.type,
		});
		return placeholder;
	});
}

function detectPromptInjection(text: string): LlmGuardFinding[] {
	return PROMPT_INJECTION_PATTERNS.flatMap((pattern) =>
		collectMatches(pattern.regex, text, pattern.type, pattern.confidence)
	);
}

function detectPiiLeakage(text: string, vault?: LlmGuardVaultSnapshot): LlmGuardFinding[] {
	const allowedValues = new Set((vault?.entries || []).map((entry) => entry.original));
	return [
		...collectMatches(EMAIL_REGEX, text, 'PII_EMAIL', 0.99),
		...collectMatches(PHONE_REGEX, text, 'PII_PHONE', 0.92),
		...collectMatches(SSN_REGEX, text, 'PII_SSN', 0.97),
	].filter((finding) => !allowedValues.has(finding.value));
}

function passesLuhnCheck(value: string): boolean {
	if (!/^\d{13,19}$/.test(value)) return false;

	let sum = 0;
	let shouldDouble = false;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		let digit = Number(value[index]);
		if (shouldDouble) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		shouldDouble = !shouldDouble;
	}

	return sum % 10 === 0;
}

export type {
	LlmGuardConfig,
	LlmGuardFinding,
	LlmGuardPostResult,
	LlmGuardPreResult,
	LlmGuardState,
	LlmGuardVaultSnapshot,
} from './types';
