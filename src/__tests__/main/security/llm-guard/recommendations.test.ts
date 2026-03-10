import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';

// Mock electron app module before importing
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/tmp/maestro-test'),
	},
}));

// Mock fs/promises module
vi.mock('fs/promises', () => ({
	appendFile: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(''),
}));

// Import after mocking
import {
	analyzeSecurityEvents,
	getRecommendations,
	getRecommendationsSummary,
	type SecurityRecommendation,
	type RecommendationSeverity,
	type RecommendationCategory,
} from '../../../../main/security/llm-guard/recommendations';
import {
	logSecurityEvent,
	clearEvents,
	type SecurityEventParams,
} from '../../../../main/security/security-logger';

describe('recommendations', () => {
	beforeEach(() => {
		clearEvents();
		vi.clearAllMocks();
	});

	afterEach(() => {
		clearEvents();
	});

	describe('analyzeSecurityEvents', () => {
		it('returns no-events recommendation when no events exist', () => {
			const recommendations = analyzeSecurityEvents({ enabled: true });

			expect(recommendations).toHaveLength(1);
			expect(recommendations[0].id).toBe('no-events-enabled');
			expect(recommendations[0].category).toBe('usage_patterns');
			expect(recommendations[0].severity).toBe('low');
		});

		it('returns disabled recommendation when LLM Guard is disabled', () => {
			const recommendations = analyzeSecurityEvents({ enabled: false });

			expect(recommendations).toHaveLength(1);
			expect(recommendations[0].id).toBe('no-events-disabled');
			expect(recommendations[0].category).toBe('configuration');
			expect(recommendations[0].severity).toBe('medium');
		});
	});

	describe('blocked content analysis', () => {
		it('generates recommendation for high volume of blocked content', async () => {
			// Create 10 blocked events (above default threshold of 5)
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 0.9 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const blockedRec = recommendations.find((r) => r.id === 'blocked-content-high-volume');
			expect(blockedRec).toBeDefined();
			expect(blockedRec!.category).toBe('blocked_content');
			expect(blockedRec!.affectedEventCount).toBe(10);
			expect(blockedRec!.severity).toBe('medium');
		});

		it('assigns high severity for very high volume of blocked content', async () => {
			// Create 30 blocked events (above threshold * 5)
			for (let i = 0; i < 30; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 0.9 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const blockedRec = recommendations.find((r) => r.id === 'blocked-content-high-volume');
			expect(blockedRec).toBeDefined();
			expect(blockedRec!.severity).toBe('high');
		});
	});

	describe('secret detection analysis', () => {
		it('generates recommendation for detected secrets', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [
							{ type: 'API_KEY', value: 'sk_test_xxx', start: 0, end: 11, confidence: 0.95 },
						],
						action: 'sanitized',
						originalLength: 100,
						sanitizedLength: 90,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const secretRec = recommendations.find((r) => r.id === 'secret-detection-volume');
			expect(secretRec).toBeDefined();
			expect(secretRec!.category).toBe('secret_detection');
			expect(secretRec!.affectedEventCount).toBe(5);
		});

		it('includes HIGH_ENTROPY findings in secret detection', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [
							{ type: 'HIGH_ENTROPY', value: 'abc123xyz', start: 0, end: 9, confidence: 0.85 },
						],
						action: 'warned',
						originalLength: 50,
						sanitizedLength: 50,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const secretRec = recommendations.find((r) => r.id === 'secret-detection-volume');
			expect(secretRec).toBeDefined();
			expect(secretRec!.relatedFindingTypes).toContain('HIGH_ENTROPY');
		});
	});

	describe('PII detection analysis', () => {
		it('generates recommendation for detected PII', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [
							{ type: 'EMAIL', value: 'test@example.com', start: 0, end: 16, confidence: 0.99 },
						],
						action: 'sanitized',
						originalLength: 100,
						sanitizedLength: 90,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const piiRec = recommendations.find((r) => r.id === 'pii-detection-volume');
			expect(piiRec).toBeDefined();
			expect(piiRec!.category).toBe('pii_detection');
			expect(piiRec!.relatedFindingTypes).toContain('EMAIL');
		});
	});

	describe('prompt injection analysis', () => {
		it('generates recommendation for prompt injection attempts', async () => {
			// Lower threshold for prompt injection - just 3 events triggers it
			for (let i = 0; i < 3; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [
							{
								type: 'PROMPT_INJECTION',
								value: 'ignore previous instructions',
								start: 0,
								end: 28,
								confidence: 0.9,
							},
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const injectionRec = recommendations.find((r) => r.id === 'prompt-injection-detected');
			expect(injectionRec).toBeDefined();
			expect(injectionRec!.category).toBe('prompt_injection');
			expect(injectionRec!.severity).toBe('medium');
		});

		it('assigns high severity for many prompt injection attempts', async () => {
			for (let i = 0; i < 15; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [
							{
								type: 'PROMPT_INJECTION',
								value: 'ignore previous instructions',
								start: 0,
								end: 28,
								confidence: 0.9,
							},
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const injectionRec = recommendations.find((r) => r.id === 'prompt-injection-detected');
			expect(injectionRec).toBeDefined();
			expect(injectionRec!.severity).toBe('high');
		});
	});

	describe('dangerous code pattern analysis', () => {
		it('generates recommendation for dangerous code patterns', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'output_scan',
						findings: [
							{
								type: 'SHELL_COMMAND',
								value: 'rm -rf /',
								start: 0,
								end: 8,
								confidence: 0.95,
							},
						],
						action: 'warned',
						originalLength: 100,
						sanitizedLength: 100,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const codeRec = recommendations.find((r) => r.id === 'dangerous-code-patterns');
			expect(codeRec).toBeDefined();
			expect(codeRec!.category).toBe('code_patterns');
		});
	});

	describe('URL detection analysis', () => {
		it('generates recommendation for malicious URLs', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'output_scan',
						findings: [
							{
								type: 'SUSPICIOUS_TLD',
								value: 'http://evil.tk',
								start: 0,
								end: 14,
								confidence: 0.8,
							},
						],
						action: 'warned',
						originalLength: 50,
						sanitizedLength: 50,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({ enabled: true });

			const urlRec = recommendations.find((r) => r.id === 'malicious-urls-detected');
			expect(urlRec).toBeDefined();
			expect(urlRec!.category).toBe('url_detection');
		});
	});

	describe('configuration analysis', () => {
		it('generates recommendation when multiple features are disabled', async () => {
			// Need at least one event for configuration analysis to run
			// (otherwise no-events recommendation is returned early)
			await logSecurityEvent(
				{
					sessionId: 'session-1',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 100,
					sanitizedLength: 100,
				},
				false
			);

			const recommendations = analyzeSecurityEvents({
				enabled: true,
				input: {
					anonymizePii: false,
					redactSecrets: false,
					detectPromptInjection: false,
					structuralAnalysis: true,
					invisibleCharacterDetection: true,
					scanUrls: true,
				},
				output: {
					deanonymizePii: false,
					redactSecrets: false,
					detectPiiLeakage: false,
					scanUrls: true,
					scanCode: true,
				},
				thresholds: {
					promptInjection: 0.7,
				},
			});

			const configRec = recommendations.find((r) => r.id === 'multiple-features-disabled');
			expect(configRec).toBeDefined();
			expect(configRec!.category).toBe('configuration');
			expect(configRec!.severity).toBe('medium');
		});

		it('generates recommendation for no custom patterns', async () => {
			// Create enough events to trigger the recommendation
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [],
						action: 'none',
						originalLength: 100,
						sanitizedLength: 100,
					},
					false
				);
			}

			const recommendations = analyzeSecurityEvents({
				enabled: true,
				customPatterns: [],
			});

			const patternRec = recommendations.find((r) => r.id === 'no-custom-patterns');
			expect(patternRec).toBeDefined();
			expect(patternRec!.category).toBe('configuration');
			expect(patternRec!.severity).toBe('low');
		});
	});

	describe('getRecommendations', () => {
		it('filters by minimum severity', async () => {
			// Create events for multiple recommendation types
			for (let i = 0; i < 30; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 0.9 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const highOnly = getRecommendations({ enabled: true }, { minSeverity: 'high' });
			const mediumAndHigh = getRecommendations({ enabled: true }, { minSeverity: 'medium' });

			// High only should have fewer recommendations
			expect(highOnly.length).toBeLessThanOrEqual(mediumAndHigh.length);
			// All high-only recommendations should be high severity
			highOnly.forEach((r) => {
				expect(r.severity).toBe('high');
			});
		});

		it('filters by category', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [{ type: 'API_KEY', value: 'sk_xxx', start: 0, end: 6, confidence: 0.95 }],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const secretsOnly = getRecommendations(
				{ enabled: true },
				{ categories: ['secret_detection'] }
			);

			secretsOnly.forEach((r) => {
				expect(r.category).toBe('secret_detection');
			});
		});

		it('excludes dismissed recommendations', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [{ type: 'API_KEY', value: 'sk_xxx', start: 0, end: 6, confidence: 0.95 }],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const all = getRecommendations({ enabled: true });
			const withDismissed = getRecommendations(
				{ enabled: true },
				{ excludeDismissed: true, dismissedIds: ['secret-detection-volume'] }
			);

			expect(withDismissed.length).toBeLessThan(all.length);
			expect(withDismissed.find((r) => r.id === 'secret-detection-volume')).toBeUndefined();
		});

		it('sorts recommendations by severity then event count', async () => {
			// Create events that generate multiple recommendations with different severities
			for (let i = 0; i < 30; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 0.9 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [
							{ type: 'EMAIL', value: 'test@test.com', start: 0, end: 13, confidence: 0.99 },
						],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const recommendations = getRecommendations({ enabled: true });

			// Check that high severity comes before medium and low
			const severityOrder: RecommendationSeverity[] = ['high', 'medium', 'low'];
			for (let i = 1; i < recommendations.length; i++) {
				const prevIdx = severityOrder.indexOf(recommendations[i - 1].severity);
				const currIdx = severityOrder.indexOf(recommendations[i].severity);
				// Previous should have same or higher severity (lower index)
				expect(prevIdx).toBeLessThanOrEqual(currIdx);
			}
		});
	});

	describe('getRecommendationsSummary', () => {
		it('returns correct counts by severity', async () => {
			// Create events for high severity recommendation
			for (let i = 0; i < 30; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 0.9 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const summary = getRecommendationsSummary({ enabled: true });

			expect(summary.total).toBeGreaterThan(0);
			expect(summary.high + summary.medium + summary.low).toBe(summary.total);
		});

		it('returns counts by category', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [{ type: 'API_KEY', value: 'sk_xxx', start: 0, end: 6, confidence: 0.95 }],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const summary = getRecommendationsSummary({ enabled: true });

			// Should have categories property
			expect(summary.categories).toBeDefined();
			expect(typeof summary.categories.secret_detection).toBe('number');
			expect(typeof summary.categories.configuration).toBe('number');
		});
	});

	describe('recommendation content', () => {
		it('includes actionable items in recommendations', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [{ type: 'API_KEY', value: 'sk_xxx', start: 0, end: 6, confidence: 0.95 }],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const recommendations = getRecommendations({ enabled: true });

			recommendations.forEach((rec) => {
				expect(rec.title).toBeTruthy();
				expect(rec.description).toBeTruthy();
				expect(Array.isArray(rec.actionItems)).toBe(true);
				expect(rec.actionItems.length).toBeGreaterThan(0);
			});
		});

		it('includes timestamp in recommendations', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'session-1',
						eventType: 'input_scan',
						findings: [{ type: 'API_KEY', value: 'sk_xxx', start: 0, end: 6, confidence: 0.95 }],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const recommendations = getRecommendations({ enabled: true });

			recommendations.forEach((rec) => {
				expect(rec.generatedAt).toBeGreaterThan(0);
				expect(rec.generatedAt).toBeLessThanOrEqual(Date.now());
			});
		});
	});
});
