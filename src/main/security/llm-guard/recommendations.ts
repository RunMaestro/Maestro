/**
 * Security Recommendations System for LLM Guard
 *
 * Analyzes security event patterns and usage statistics to provide
 * actionable recommendations for improving security posture.
 */

import type { LlmGuardConfig } from './types';
import { getAllEvents, type SecurityEvent } from '../security-logger';

/**
 * Recommendation severity levels
 */
export type RecommendationSeverity = 'low' | 'medium' | 'high';

/**
 * Recommendation categories
 */
export type RecommendationCategory =
	| 'blocked_content'
	| 'secret_detection'
	| 'pii_detection'
	| 'prompt_injection'
	| 'code_patterns'
	| 'url_detection'
	| 'configuration'
	| 'usage_patterns';

/**
 * A security recommendation
 */
export interface SecurityRecommendation {
	/** Unique identifier for this recommendation */
	id: string;
	/** Category of the recommendation */
	category: RecommendationCategory;
	/** Severity level */
	severity: RecommendationSeverity;
	/** Short title */
	title: string;
	/** Detailed description */
	description: string;
	/** Suggested actions to address the recommendation */
	actionItems: string[];
	/** Number of events that triggered this recommendation */
	affectedEventCount: number;
	/** Finding types that triggered this recommendation */
	relatedFindingTypes: string[];
	/** Timestamp when this recommendation was generated */
	generatedAt: number;
	/** Optional: Unix timestamp until which this recommendation is dismissed */
	dismissedUntil?: number;
}

/**
 * Configuration for the recommendations analyzer
 */
export interface RecommendationsConfig {
	/** Minimum number of events to trigger a recommendation (default: 5) */
	minEventThreshold: number;
	/** Look-back window in days (default: 30) */
	lookbackDays: number;
	/** Enable low-severity recommendations (default: true) */
	showLowSeverity: boolean;
}

const DEFAULT_CONFIG: RecommendationsConfig = {
	minEventThreshold: 5,
	lookbackDays: 30,
	showLowSeverity: true,
};

/**
 * Analyze security events and generate recommendations
 */
export function analyzeSecurityEvents(
	config: Partial<LlmGuardConfig> = {},
	recommendationsConfig: Partial<RecommendationsConfig> = {}
): SecurityRecommendation[] {
	const mergedConfig = { ...DEFAULT_CONFIG, ...recommendationsConfig };
	const recommendations: SecurityRecommendation[] = [];

	// Get all events from the buffer
	const allEvents = getAllEvents();

	// Filter events within look-back window
	const cutoffTime = Date.now() - mergedConfig.lookbackDays * 24 * 60 * 60 * 1000;
	const recentEvents = allEvents.filter((e) => e.timestamp >= cutoffTime);

	// Skip analysis if no events
	if (recentEvents.length === 0) {
		// No security events recommendation
		recommendations.push(createNoEventsRecommendation(config, mergedConfig.lookbackDays));
		return recommendations;
	}

	// Analyze blocked content patterns
	const blockedRecommendations = analyzeBlockedContent(recentEvents, mergedConfig);
	recommendations.push(...blockedRecommendations);

	// Analyze secret detection patterns
	const secretRecommendations = analyzeSecretDetection(recentEvents, mergedConfig);
	recommendations.push(...secretRecommendations);

	// Analyze PII detection patterns
	const piiRecommendations = analyzePiiDetection(recentEvents, mergedConfig);
	recommendations.push(...piiRecommendations);

	// Analyze prompt injection patterns
	const injectionRecommendations = analyzePromptInjection(recentEvents, mergedConfig);
	recommendations.push(...injectionRecommendations);

	// Analyze code pattern detections
	const codeRecommendations = analyzeCodePatterns(recentEvents, mergedConfig);
	recommendations.push(...codeRecommendations);

	// Analyze URL detection patterns
	const urlRecommendations = analyzeUrlDetection(recentEvents, mergedConfig);
	recommendations.push(...urlRecommendations);

	// Analyze configuration improvements
	const configRecommendations = analyzeConfiguration(config, recentEvents, mergedConfig);
	recommendations.push(...configRecommendations);

	// Filter out low-severity if disabled
	if (!mergedConfig.showLowSeverity) {
		return recommendations.filter((r) => r.severity !== 'low');
	}

	return recommendations;
}

/**
 * Create a recommendation for when no security events are found
 */
function createNoEventsRecommendation(
	config: Partial<LlmGuardConfig>,
	lookbackDays: number
): SecurityRecommendation {
	const isEnabled = config.enabled !== false;

	if (!isEnabled) {
		return {
			id: 'no-events-disabled',
			category: 'configuration',
			severity: 'medium',
			title: 'LLM Guard is disabled',
			description: `LLM Guard has been disabled. No security scanning is active, which means sensitive data like secrets, PII, and prompt injections are not being detected.`,
			actionItems: [
				'Enable LLM Guard in Settings → Security to activate protection',
				'Consider enabling at least basic protections like secret detection',
			],
			affectedEventCount: 0,
			relatedFindingTypes: [],
			generatedAt: Date.now(),
		};
	}

	return {
		id: 'no-events-enabled',
		category: 'usage_patterns',
		severity: 'low',
		title: 'No security events in the last ' + lookbackDays + ' days',
		description: `LLM Guard is enabled but hasn't detected any issues in the past ${lookbackDays} days. This could mean your usage is clean, or the guard may be too strict/unused.`,
		actionItems: [
			'Verify that LLM Guard scanning is working correctly',
			'Consider testing with sample sensitive data to validate detection',
			'Review if the current thresholds are appropriate for your use case',
		],
		affectedEventCount: 0,
		relatedFindingTypes: [],
		generatedAt: Date.now(),
	};
}

/**
 * Analyze blocked content patterns
 */
function analyzeBlockedContent(
	events: SecurityEvent[],
	config: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	const blockedEvents = events.filter((e) => e.action === 'blocked');

	if (blockedEvents.length >= config.minEventThreshold) {
		// Group by finding types
		const findingTypeCounts = new Map<string, number>();
		for (const event of blockedEvents) {
			for (const finding of event.findings) {
				findingTypeCounts.set(finding.type, (findingTypeCounts.get(finding.type) || 0) + 1);
			}
		}

		const topTypes = [...findingTypeCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([type]) => type);

		const severity: RecommendationSeverity =
			blockedEvents.length >= config.minEventThreshold * 5
				? 'high'
				: blockedEvents.length >= config.minEventThreshold * 2
					? 'medium'
					: 'low';

		recommendations.push({
			id: 'blocked-content-high-volume',
			category: 'blocked_content',
			severity,
			title: `${blockedEvents.length} blocked prompts detected`,
			description: `LLM Guard has blocked ${blockedEvents.length} prompts in the past ${config.lookbackDays} days. This indicates potential policy violations or overly strict settings.`,
			actionItems: [
				'Review the blocked content in the Security Events panel',
				'Consider adjusting ban patterns if legitimate content is being blocked',
				'Add specific exceptions for known-good patterns if needed',
				'Check if the action mode should be changed from "Block" to "Warn" for some categories',
			],
			affectedEventCount: blockedEvents.length,
			relatedFindingTypes: topTypes,
			generatedAt: Date.now(),
		});
	}

	return recommendations;
}

/**
 * Analyze secret detection patterns
 */
function analyzeSecretDetection(
	events: SecurityEvent[],
	config: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	const secretFindingTypes = [
		'API_KEY',
		'SECRET_KEY',
		'PRIVATE_KEY',
		'AWS_ACCESS_KEY',
		'PASSWORD',
		'TOKEN',
		'HIGH_ENTROPY',
		'CUSTOM_SECRET',
	];

	const secretEvents = events.filter((e) =>
		e.findings.some((f) => secretFindingTypes.some((t) => f.type.includes(t)))
	);

	if (secretEvents.length >= config.minEventThreshold) {
		const totalSecrets = secretEvents.reduce(
			(sum, e) =>
				sum + e.findings.filter((f) => secretFindingTypes.some((t) => f.type.includes(t))).length,
			0
		);

		const uniqueTypes = [
			...new Set(
				secretEvents.flatMap((e) =>
					e.findings
						.filter((f) => secretFindingTypes.some((t) => f.type.includes(t)))
						.map((f) => f.type)
				)
			),
		];

		const severity: RecommendationSeverity =
			totalSecrets >= config.minEventThreshold * 10
				? 'high'
				: totalSecrets >= config.minEventThreshold * 3
					? 'medium'
					: 'low';

		recommendations.push({
			id: 'secret-detection-volume',
			category: 'secret_detection',
			severity,
			title: `Entropy detection caught ${totalSecrets} potential secrets`,
			description: `LLM Guard detected ${totalSecrets} potential secrets across ${secretEvents.length} events. Your team may benefit from stricter credential handling practices.`,
			actionItems: [
				'Review the detected secrets in the Security Events panel',
				'Consider implementing pre-commit hooks to prevent secrets from entering the codebase',
				'Use environment variables or secret managers instead of hardcoded credentials',
				'Add custom patterns for your team-specific secret formats',
			],
			affectedEventCount: secretEvents.length,
			relatedFindingTypes: uniqueTypes,
			generatedAt: Date.now(),
		});
	}

	return recommendations;
}

/**
 * Analyze PII detection patterns
 */
function analyzePiiDetection(
	events: SecurityEvent[],
	config: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	const piiFindingTypes = [
		'EMAIL',
		'PHONE',
		'SSN',
		'CREDIT_CARD',
		'ADDRESS',
		'NAME',
		'DOB',
		'PII',
		'CUSTOM_PII',
	];

	const piiEvents = events.filter((e) =>
		e.findings.some((f) => piiFindingTypes.some((t) => f.type.includes(t)))
	);

	if (piiEvents.length >= config.minEventThreshold) {
		const totalPii = piiEvents.reduce(
			(sum, e) =>
				sum + e.findings.filter((f) => piiFindingTypes.some((t) => f.type.includes(t))).length,
			0
		);

		const uniqueTypes = [
			...new Set(
				piiEvents.flatMap((e) =>
					e.findings
						.filter((f) => piiFindingTypes.some((t) => f.type.includes(t)))
						.map((f) => f.type)
				)
			),
		];

		const severity: RecommendationSeverity =
			totalPii >= config.minEventThreshold * 10
				? 'high'
				: totalPii >= config.minEventThreshold * 3
					? 'medium'
					: 'low';

		recommendations.push({
			id: 'pii-detection-volume',
			category: 'pii_detection',
			severity,
			title: `${totalPii} PII instances detected`,
			description: `LLM Guard detected ${totalPii} instances of personally identifiable information across ${piiEvents.length} events. Consider reviewing data handling practices.`,
			actionItems: [
				'Review detected PII in the Security Events panel',
				'Ensure PII anonymization is enabled for sensitive workflows',
				'Consider using synthetic or anonymized data for development',
				"Review your organization's data privacy compliance requirements",
			],
			affectedEventCount: piiEvents.length,
			relatedFindingTypes: uniqueTypes,
			generatedAt: Date.now(),
		});
	}

	return recommendations;
}

/**
 * Analyze prompt injection patterns
 */
function analyzePromptInjection(
	events: SecurityEvent[],
	config: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	const injectionFindingTypes = [
		'PROMPT_INJECTION',
		'SYSTEM_INSTRUCTION_OVERRIDE',
		'ROLE_OVERRIDE',
		'CHATML_DELIMITER',
		'LLAMA_DELIMITER',
		'STRUCTURAL_INJECTION',
		'OUTPUT_INJECTION',
		'INVISIBLE_CHARS',
		'HOMOGLYPHS',
		'CUSTOM_INJECTION',
	];

	const injectionEvents = events.filter((e) =>
		e.findings.some((f) => injectionFindingTypes.some((t) => f.type.includes(t)))
	);

	if (injectionEvents.length >= Math.max(1, Math.floor(config.minEventThreshold / 2))) {
		const uniqueTypes = [
			...new Set(
				injectionEvents.flatMap((e) =>
					e.findings
						.filter((f) => injectionFindingTypes.some((t) => f.type.includes(t)))
						.map((f) => f.type)
				)
			),
		];

		// Prompt injections are always high severity
		const severity: RecommendationSeverity =
			injectionEvents.length >= config.minEventThreshold * 2 ? 'high' : 'medium';

		recommendations.push({
			id: 'prompt-injection-detected',
			category: 'prompt_injection',
			severity,
			title: `${injectionEvents.length} prompt injection attempts detected`,
			description: `LLM Guard detected ${injectionEvents.length} potential prompt injection attempts. This is a serious security concern that could lead to unintended AI behavior.`,
			actionItems: [
				'Review detected injections in the Security Events panel',
				'Consider lowering the prompt injection threshold for stricter detection',
				'Enable structural analysis if not already active',
				'Review if input sources may be compromised or contain malicious content',
				'Consider blocking mode for prompt injection detection',
			],
			affectedEventCount: injectionEvents.length,
			relatedFindingTypes: uniqueTypes,
			generatedAt: Date.now(),
		});
	}

	return recommendations;
}

/**
 * Analyze dangerous code pattern detections
 */
function analyzeCodePatterns(
	events: SecurityEvent[],
	config: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	const codeFindingTypes = [
		'DANGEROUS_CODE',
		'SHELL_COMMAND',
		'SQL_INJECTION',
		'COMMAND_INJECTION',
		'SENSITIVE_FILE_ACCESS',
		'NETWORK_OPERATION',
		'DESTRUCTIVE_COMMAND',
		'PRIVILEGE_ESCALATION',
	];

	const codeEvents = events.filter((e) =>
		e.findings.some((f) => codeFindingTypes.some((t) => f.type.includes(t)))
	);

	if (codeEvents.length >= config.minEventThreshold) {
		const uniqueTypes = [
			...new Set(
				codeEvents.flatMap((e) =>
					e.findings
						.filter((f) => codeFindingTypes.some((t) => f.type.includes(t)))
						.map((f) => f.type)
				)
			),
		];

		const severity: RecommendationSeverity =
			codeEvents.length >= config.minEventThreshold * 3 ? 'high' : 'medium';

		recommendations.push({
			id: 'dangerous-code-patterns',
			category: 'code_patterns',
			severity,
			title: `${codeEvents.length} dangerous code patterns detected`,
			description: `LLM Guard detected ${codeEvents.length} potentially dangerous code patterns in AI responses. These could pose security risks if executed.`,
			actionItems: [
				'Review detected patterns in the Security Events panel',
				'Be cautious when executing AI-generated code',
				'Enable code scanning if not already active',
				'Consider sandboxing AI-generated code execution',
			],
			affectedEventCount: codeEvents.length,
			relatedFindingTypes: uniqueTypes,
			generatedAt: Date.now(),
		});
	}

	return recommendations;
}

/**
 * Analyze URL detection patterns
 */
function analyzeUrlDetection(
	events: SecurityEvent[],
	config: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	const urlFindingTypes = [
		'MALICIOUS_URL',
		'SUSPICIOUS_TLD',
		'IP_ADDRESS_URL',
		'ENCODED_HOSTNAME',
		'EXCESSIVE_SUBDOMAINS',
		'PUNYCODE_DOMAIN',
		'URL_SHORTENER',
	];

	const urlEvents = events.filter((e) =>
		e.findings.some((f) => urlFindingTypes.some((t) => f.type.includes(t)))
	);

	if (urlEvents.length >= config.minEventThreshold) {
		const uniqueTypes = [
			...new Set(
				urlEvents.flatMap((e) =>
					e.findings
						.filter((f) => urlFindingTypes.some((t) => f.type.includes(t)))
						.map((f) => f.type)
				)
			),
		];

		const severity: RecommendationSeverity =
			urlEvents.length >= config.minEventThreshold * 3 ? 'high' : 'medium';

		recommendations.push({
			id: 'malicious-urls-detected',
			category: 'url_detection',
			severity,
			title: `${urlEvents.length} suspicious URLs detected`,
			description: `LLM Guard detected ${urlEvents.length} potentially malicious or suspicious URLs. Be cautious when visiting or interacting with these links.`,
			actionItems: [
				'Review detected URLs in the Security Events panel',
				'Verify URL legitimacy before clicking',
				'Enable URL scanning if not already active',
				'Consider blocking URLs with suspicious characteristics',
			],
			affectedEventCount: urlEvents.length,
			relatedFindingTypes: uniqueTypes,
			generatedAt: Date.now(),
		});
	}

	return recommendations;
}

/**
 * Analyze configuration and suggest improvements
 */
function analyzeConfiguration(
	config: Partial<LlmGuardConfig>,
	events: SecurityEvent[],
	recommendationsConfig: RecommendationsConfig
): SecurityRecommendation[] {
	const recommendations: SecurityRecommendation[] = [];

	// Check for disabled features
	const disabledFeatures: string[] = [];

	if (config.input?.anonymizePii === false) {
		disabledFeatures.push('PII anonymization');
	}
	if (config.input?.redactSecrets === false) {
		disabledFeatures.push('Secret redaction');
	}
	if (config.input?.detectPromptInjection === false) {
		disabledFeatures.push('Prompt injection detection');
	}
	if (config.input?.structuralAnalysis === false) {
		disabledFeatures.push('Structural analysis');
	}
	if (config.input?.invisibleCharacterDetection === false) {
		disabledFeatures.push('Invisible character detection');
	}
	if (config.input?.scanUrls === false) {
		disabledFeatures.push('Input URL scanning');
	}
	if (config.output?.scanUrls === false) {
		disabledFeatures.push('Output URL scanning');
	}
	if (config.output?.scanCode === false) {
		disabledFeatures.push('Dangerous code scanning');
	}
	if (config.groupChat?.interAgentScanEnabled === false) {
		disabledFeatures.push('Inter-agent scanning');
	}

	if (disabledFeatures.length >= 3) {
		recommendations.push({
			id: 'multiple-features-disabled',
			category: 'configuration',
			severity: 'medium',
			title: `${disabledFeatures.length} security features are disabled`,
			description: `Several security features are currently disabled: ${disabledFeatures.join(', ')}. Consider enabling these for better protection.`,
			actionItems: [
				'Review disabled features in Settings → Security',
				'Enable features that are appropriate for your use case',
				'Consider the trade-off between security and usability',
			],
			affectedEventCount: 0,
			relatedFindingTypes: [],
			generatedAt: Date.now(),
		});
	}

	// Check if threshold is too high (might miss detections)
	if (config.thresholds?.promptInjection !== undefined && config.thresholds.promptInjection > 0.8) {
		// Check if there are events with low confidence that might be missed
		const lowConfidenceEvents = events.filter((e) =>
			e.findings.some(
				(f) =>
					f.type.includes('INJECTION') &&
					f.confidence < config.thresholds!.promptInjection &&
					f.confidence >= 0.5
			)
		);

		if (lowConfidenceEvents.length >= recommendationsConfig.minEventThreshold) {
			recommendations.push({
				id: 'threshold-too-high',
				category: 'configuration',
				severity: 'low',
				title: 'Prompt injection threshold may be too high',
				description: `The prompt injection threshold is set to ${Math.round(config.thresholds.promptInjection * 100)}%, but ${lowConfidenceEvents.length} events had findings below this threshold. You might be missing some detections.`,
				actionItems: [
					'Consider lowering the prompt injection threshold',
					'Review the missed detections to determine appropriate threshold',
					`Current threshold: ${Math.round(config.thresholds.promptInjection * 100)}%`,
				],
				affectedEventCount: lowConfidenceEvents.length,
				relatedFindingTypes: ['PROMPT_INJECTION'],
				generatedAt: Date.now(),
			});
		}
	}

	// Check if no custom patterns are defined
	if (!config.customPatterns || config.customPatterns.length === 0) {
		const hasCustomFindingTypes = events.some((e) =>
			e.findings.some((f) => f.type.startsWith('CUSTOM_'))
		);

		if (!hasCustomFindingTypes && events.length >= recommendationsConfig.minEventThreshold * 2) {
			recommendations.push({
				id: 'no-custom-patterns',
				category: 'configuration',
				severity: 'low',
				title: 'No custom patterns defined',
				description:
					'You have no custom regex patterns defined. Custom patterns can help detect organization-specific sensitive data formats.',
				actionItems: [
					'Define custom patterns for internal project names',
					'Add patterns for team-specific credential formats',
					'Create patterns for proprietary data identifiers',
				],
				affectedEventCount: 0,
				relatedFindingTypes: [],
				generatedAt: Date.now(),
			});
		}
	}

	// Check action mode
	if (config.action === 'warn') {
		const warnedEvents = events.filter((e) => e.action === 'warned');
		const highConfidenceWarnings = warnedEvents.filter((e) =>
			e.findings.some((f) => f.confidence >= 0.9)
		);

		if (highConfidenceWarnings.length >= recommendationsConfig.minEventThreshold * 2) {
			recommendations.push({
				id: 'consider-sanitize-mode',
				category: 'configuration',
				severity: 'low',
				title: 'Consider enabling Sanitize mode',
				description: `${highConfidenceWarnings.length} high-confidence warnings were generated. Consider switching to Sanitize mode for automatic remediation of detected issues.`,
				actionItems: [
					'Review high-confidence warnings in Security Events panel',
					'Consider switching from Warn to Sanitize mode',
					'Sanitize mode automatically redacts detected sensitive content',
				],
				affectedEventCount: highConfidenceWarnings.length,
				relatedFindingTypes: [],
				generatedAt: Date.now(),
			});
		}
	}

	return recommendations;
}

/**
 * Get recommendations with optional filtering
 */
export function getRecommendations(
	config: Partial<LlmGuardConfig> = {},
	options: {
		minSeverity?: RecommendationSeverity;
		categories?: RecommendationCategory[];
		excludeDismissed?: boolean;
		dismissedIds?: string[];
	} = {}
): SecurityRecommendation[] {
	const recommendations = analyzeSecurityEvents(config);

	// Filter by minimum severity
	const severityOrder: RecommendationSeverity[] = ['low', 'medium', 'high'];
	let filtered = recommendations;

	if (options.minSeverity) {
		const minIndex = severityOrder.indexOf(options.minSeverity);
		filtered = filtered.filter((r) => severityOrder.indexOf(r.severity) >= minIndex);
	}

	// Filter by categories
	if (options.categories && options.categories.length > 0) {
		filtered = filtered.filter((r) => options.categories!.includes(r.category));
	}

	// Exclude dismissed recommendations
	if (options.excludeDismissed && options.dismissedIds) {
		filtered = filtered.filter((r) => !options.dismissedIds!.includes(r.id));
	}

	// Sort by severity (high first) then by event count
	filtered.sort((a, b) => {
		const severityDiff = severityOrder.indexOf(b.severity) - severityOrder.indexOf(a.severity);
		if (severityDiff !== 0) return severityDiff;
		return b.affectedEventCount - a.affectedEventCount;
	});

	return filtered;
}

/**
 * Get a summary of recommendations by severity
 */
export function getRecommendationsSummary(config: Partial<LlmGuardConfig> = {}): {
	total: number;
	high: number;
	medium: number;
	low: number;
	categories: Record<RecommendationCategory, number>;
} {
	const recommendations = analyzeSecurityEvents(config);

	const summary = {
		total: recommendations.length,
		high: recommendations.filter((r) => r.severity === 'high').length,
		medium: recommendations.filter((r) => r.severity === 'medium').length,
		low: recommendations.filter((r) => r.severity === 'low').length,
		categories: {} as Record<RecommendationCategory, number>,
	};

	// Count by category
	const allCategories: RecommendationCategory[] = [
		'blocked_content',
		'secret_detection',
		'pii_detection',
		'prompt_injection',
		'code_patterns',
		'url_detection',
		'configuration',
		'usage_patterns',
	];

	for (const category of allCategories) {
		summary.categories[category] = recommendations.filter((r) => r.category === category).length;
	}

	return summary;
}
