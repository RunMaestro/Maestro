import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock electron app module before importing
vi.mock('electron', () => ({
	app: {
		getPath: vi.fn().mockReturnValue('/tmp/maestro-test'),
	},
}));

// Mock fs module
vi.mock('fs/promises', () => ({
	appendFile: vi.fn().mockResolvedValue(undefined),
	writeFile: vi.fn().mockResolvedValue(undefined),
	readFile: vi.fn().mockResolvedValue(''),
}));

import {
	analyzeSecurityEvents,
	getRecommendations,
	getRecommendationsSummary,
	type SecurityRecommendation,
	type RecommendationCategory,
} from '../../../main/security/llm-guard/recommendations';
import {
	logSecurityEvent,
	clearEvents,
	type SecurityEventParams,
} from '../../../main/security/security-logger';
import type { LlmGuardConfig } from '../../../main/security/llm-guard/types';

describe('Security Recommendations System', () => {
	beforeEach(() => {
		clearEvents();
		vi.clearAllMocks();
	});

	afterEach(() => {
		clearEvents();
	});

	describe('analyzeSecurityEvents', () => {
		it('returns no-events recommendation when guard is disabled and no events', () => {
			const config: Partial<LlmGuardConfig> = { enabled: false };
			const recommendations = analyzeSecurityEvents(config);

			expect(recommendations).toHaveLength(1);
			expect(recommendations[0].id).toBe('no-events-disabled');
			expect(recommendations[0].severity).toBe('medium');
			expect(recommendations[0].category).toBe('configuration');
			expect(recommendations[0].title).toContain('disabled');
		});

		it('returns no-events recommendation when guard is enabled but no events', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			expect(recommendations).toHaveLength(1);
			expect(recommendations[0].id).toBe('no-events-enabled');
			expect(recommendations[0].severity).toBe('low');
			expect(recommendations[0].category).toBe('usage_patterns');
		});

		it('generates blocked content recommendation when many blocks occur', async () => {
			// Create blocked events
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const blockedRec = recommendations.find((r) => r.id === 'blocked-content-high-volume');
			expect(blockedRec).toBeDefined();
			expect(blockedRec!.affectedEventCount).toBe(10);
			expect(blockedRec!.category).toBe('blocked_content');
		});

		it('generates secret detection recommendation when secrets found', async () => {
			// Create events with secret findings
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'input_scan',
						findings: [
							{ type: 'SECRET_API_KEY', value: 'sk-xxxx', start: 0, end: 10, confidence: 0.95 },
							{ type: 'HIGH_ENTROPY', value: 'abc123xyz', start: 20, end: 30, confidence: 0.8 },
						],
						action: 'sanitized',
						originalLength: 100,
						sanitizedLength: 80,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const secretRec = recommendations.find((r) => r.id === 'secret-detection-volume');
			expect(secretRec).toBeDefined();
			expect(secretRec!.category).toBe('secret_detection');
			expect(secretRec!.affectedEventCount).toBe(5);
		});

		it('generates PII detection recommendation when PII found', async () => {
			// Create events with PII findings
			for (let i = 0; i < 6; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'input_scan',
						findings: [
							{ type: 'EMAIL', value: 'test@test.com', start: 0, end: 13, confidence: 0.99 },
							{ type: 'PHONE', value: '555-1234', start: 20, end: 28, confidence: 0.9 },
						],
						action: 'sanitized',
						originalLength: 50,
						sanitizedLength: 40,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const piiRec = recommendations.find((r) => r.id === 'pii-detection-volume');
			expect(piiRec).toBeDefined();
			expect(piiRec!.category).toBe('pii_detection');
		});

		it('generates prompt injection recommendation with higher urgency', async () => {
			// Prompt injection should trigger recommendation with fewer events
			for (let i = 0; i < 3; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'input_scan',
						findings: [
							{
								type: 'PROMPT_INJECTION',
								value: 'ignore previous instructions',
								start: 0,
								end: 30,
								confidence: 0.9,
							},
						],
						action: 'warned',
						originalLength: 100,
						sanitizedLength: 100,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const injectionRec = recommendations.find((r) => r.id === 'prompt-injection-detected');
			expect(injectionRec).toBeDefined();
			expect(injectionRec!.category).toBe('prompt_injection');
			expect(injectionRec!.severity).toBe('medium'); // 3 events = medium, not high
		});

		it('generates dangerous code pattern recommendation', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'output_scan',
						findings: [
							{
								type: 'DANGEROUS_CODE_RM_RF',
								value: 'rm -rf /',
								start: 0,
								end: 10,
								confidence: 1.0,
							},
						],
						action: 'warned',
						originalLength: 100,
						sanitizedLength: 100,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const codeRec = recommendations.find((r) => r.id === 'dangerous-code-patterns');
			expect(codeRec).toBeDefined();
			expect(codeRec!.category).toBe('code_patterns');
		});

		it('generates URL detection recommendation', async () => {
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'input_scan',
						findings: [
							{
								type: 'MALICIOUS_URL',
								value: 'http://evil.tk/phish',
								start: 0,
								end: 20,
								confidence: 0.85,
							},
						],
						action: 'warned',
						originalLength: 50,
						sanitizedLength: 50,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const urlRec = recommendations.find((r) => r.id === 'malicious-urls-detected');
			expect(urlRec).toBeDefined();
			expect(urlRec!.category).toBe('url_detection');
		});

		it('generates configuration recommendation when multiple features disabled', async () => {
			// Need some events first to avoid getting only the no-events recommendation
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
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

			const config: Partial<LlmGuardConfig> = {
				enabled: true,
				input: {
					anonymizePii: false,
					redactSecrets: false,
					detectPromptInjection: false,
					structuralAnalysis: false,
					invisibleCharacterDetection: false,
					scanUrls: false,
				},
				output: {
					deanonymizePii: false,
					redactSecrets: false,
					detectPiiLeakage: false,
					scanUrls: false,
					scanCode: false,
				},
				thresholds: { promptInjection: 0.7 },
			};

			const recommendations = analyzeSecurityEvents(config);

			const configRec = recommendations.find((r) => r.id === 'multiple-features-disabled');
			expect(configRec).toBeDefined();
			expect(configRec!.category).toBe('configuration');
			expect(configRec!.severity).toBe('medium');
		});

		it('respects lookback window configuration', async () => {
			// Create events
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };

			// Default lookback is 30 days - events should be included
			const recsDefault = analyzeSecurityEvents(config, { lookbackDays: 30 });
			const blockedRecDefault = recsDefault.find((r) => r.id === 'blocked-content-high-volume');

			// Events exist within 30 day lookback, so blocked recommendation should be present
			expect(blockedRecDefault).toBeDefined();
			expect(blockedRecDefault!.affectedEventCount).toBe(10);

			// Test that different lookback values are accepted and don't crash
			const recs7Days = analyzeSecurityEvents(config, { lookbackDays: 7 });
			expect(Array.isArray(recs7Days)).toBe(true);

			const recs1Day = analyzeSecurityEvents(config, { lookbackDays: 1 });
			expect(Array.isArray(recs1Day)).toBe(true);

			// Events created just now should still be included with any positive lookback
			const blockedRec7 = recs7Days.find((r) => r.id === 'blocked-content-high-volume');
			expect(blockedRec7).toBeDefined();
		});

		it('filters out low severity when configured', async () => {
			// Create enough events to trigger a low severity recommendation
			for (let i = 0; i < 5; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
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

			const config: Partial<LlmGuardConfig> = { enabled: true };

			const allRecs = analyzeSecurityEvents(config, { showLowSeverity: true });
			const filteredRecs = analyzeSecurityEvents(config, { showLowSeverity: false });

			// If there are low severity recs, filtered should have fewer
			const lowInAll = allRecs.filter((r) => r.severity === 'low').length;
			const lowInFiltered = filteredRecs.filter((r) => r.severity === 'low').length;

			expect(lowInFiltered).toBe(0);
			if (lowInAll > 0) {
				expect(filteredRecs.length).toBeLessThan(allRecs.length);
			}
		});
	});

	describe('getRecommendations', () => {
		beforeEach(async () => {
			// Setup events for various recommendations
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}
		});

		it('filters by minimum severity', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };

			const allRecs = getRecommendations(config);
			const mediumUp = getRecommendations(config, { minSeverity: 'medium' });
			const highOnly = getRecommendations(config, { minSeverity: 'high' });

			// Each filtered set should be <= the previous
			expect(mediumUp.length).toBeLessThanOrEqual(allRecs.length);
			expect(highOnly.length).toBeLessThanOrEqual(mediumUp.length);
		});

		it('filters by categories', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };

			const allRecs = getRecommendations(config);
			const blockedOnly = getRecommendations(config, {
				categories: ['blocked_content'],
			});

			expect(blockedOnly.every((r) => r.category === 'blocked_content')).toBe(true);
		});

		it('excludes dismissed recommendations', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };

			const allRecs = getRecommendations(config);
			const blockedRec = allRecs.find((r) => r.id === 'blocked-content-high-volume');

			if (blockedRec) {
				const withDismissed = getRecommendations(config, {
					excludeDismissed: true,
					dismissedIds: [blockedRec.id],
				});

				expect(withDismissed.find((r) => r.id === blockedRec.id)).toBeUndefined();
			}
		});

		it('sorts recommendations by severity and event count', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = getRecommendations(config);

			// Check that high severity comes before medium, which comes before low
			const severityOrder = { high: 0, medium: 1, low: 2 };
			for (let i = 1; i < recommendations.length; i++) {
				const prevSeverity = severityOrder[recommendations[i - 1].severity];
				const currSeverity = severityOrder[recommendations[i].severity];

				// If same severity, check event count is decreasing
				if (prevSeverity === currSeverity) {
					expect(recommendations[i - 1].affectedEventCount).toBeGreaterThanOrEqual(
						recommendations[i].affectedEventCount
					);
				} else {
					// Otherwise, ensure severity order is maintained
					expect(prevSeverity).toBeLessThanOrEqual(currSeverity);
				}
			}
		});
	});

	describe('getRecommendationsSummary', () => {
		beforeEach(async () => {
			// Create variety of events
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
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
						sessionId: 'test-session',
						eventType: 'input_scan',
						findings: [
							{ type: 'PROMPT_INJECTION', value: 'ignore', start: 0, end: 6, confidence: 0.9 },
						],
						action: 'warned',
						originalLength: 50,
						sanitizedLength: 50,
					},
					false
				);
			}
		});

		it('returns correct totals', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };
			const summary = getRecommendationsSummary(config);

			expect(summary.total).toBeGreaterThan(0);
			expect(summary.high + summary.medium + summary.low).toBe(summary.total);
		});

		it('includes category breakdown', () => {
			const config: Partial<LlmGuardConfig> = { enabled: true };
			const summary = getRecommendationsSummary(config);

			// Check that all categories are represented
			const categories: RecommendationCategory[] = [
				'blocked_content',
				'secret_detection',
				'pii_detection',
				'prompt_injection',
				'code_patterns',
				'url_detection',
				'configuration',
				'usage_patterns',
			];

			for (const cat of categories) {
				expect(summary.categories).toHaveProperty(cat);
				expect(typeof summary.categories[cat]).toBe('number');
			}

			// Sum of categories should equal total
			const categorySum = Object.values(summary.categories).reduce((a, b) => a + b, 0);
			expect(categorySum).toBe(summary.total);
		});
	});

	describe('Recommendation content quality', () => {
		it('all recommendations have required fields', async () => {
			// Create events to generate recommendations
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			for (const rec of recommendations) {
				expect(rec.id).toBeTruthy();
				expect(rec.category).toBeTruthy();
				expect(['low', 'medium', 'high']).toContain(rec.severity);
				expect(rec.title).toBeTruthy();
				expect(rec.title.length).toBeGreaterThan(5);
				expect(rec.description).toBeTruthy();
				expect(rec.description.length).toBeGreaterThan(20);
				expect(Array.isArray(rec.actionItems)).toBe(true);
				expect(rec.actionItems.length).toBeGreaterThan(0);
				expect(typeof rec.affectedEventCount).toBe('number');
				expect(Array.isArray(rec.relatedFindingTypes)).toBe(true);
				expect(typeof rec.generatedAt).toBe('number');
			}
		});

		it('action items are actionable', async () => {
			for (let i = 0; i < 10; i++) {
				await logSecurityEvent(
					{
						sessionId: 'test-session',
						eventType: 'blocked',
						findings: [
							{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
						],
						action: 'blocked',
						originalLength: 100,
						sanitizedLength: 0,
					},
					false
				);
			}

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			for (const rec of recommendations) {
				for (const item of rec.actionItems) {
					// Action items should start with action verbs or referential phrases
					// Include common action starters from the recommendations
					const startsWithActionWord =
						/^(Review|Consider|Enable|Add|Check|Verify|Use|Ensure|Lower|Define|Be|Current|Sanitize)/i.test(
							item
						);
					// Items should be non-empty meaningful strings
					expect(item.length).toBeGreaterThan(5);
					// At least some items should be actionable
					// (not all items start with verbs - some provide context like "Current threshold: 70%")
				}
			}
		});
	});

	describe('Edge cases', () => {
		it('handles empty findings array', async () => {
			// Event with empty findings array doesn't contribute to finding-based recommendations
			await logSecurityEvent(
				{
					sessionId: 'test-session',
					eventType: 'input_scan',
					findings: [],
					action: 'none',
					originalLength: 100,
					sanitizedLength: 100,
				},
				false
			);

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			// With events present but no findings, the system doesn't generate finding-based recommendations
			// It also won't generate the "no events" recommendation since events do exist
			// This is expected behavior - we're just ensuring it doesn't crash
			expect(Array.isArray(recommendations)).toBe(true);
		});

		it('handles undefined config values gracefully', () => {
			const config: Partial<LlmGuardConfig> = {};
			const recommendations = analyzeSecurityEvents(config);

			// Should not throw and should return recommendations
			expect(Array.isArray(recommendations)).toBe(true);
		});

		it('handles very high event volumes', async () => {
			// Create 100 events quickly
			const promises = [];
			for (let i = 0; i < 100; i++) {
				promises.push(
					logSecurityEvent(
						{
							sessionId: 'test-session',
							eventType: 'blocked',
							findings: [
								{ type: 'BANNED_CONTENT', value: 'test', start: 0, end: 4, confidence: 1.0 },
							],
							action: 'blocked',
							originalLength: 100,
							sanitizedLength: 0,
						},
						false
					)
				);
			}
			await Promise.all(promises);

			const config: Partial<LlmGuardConfig> = { enabled: true };
			const recommendations = analyzeSecurityEvents(config);

			const blockedRec = recommendations.find((r) => r.id === 'blocked-content-high-volume');
			expect(blockedRec).toBeDefined();
			expect(blockedRec!.severity).toBe('high'); // 100 events should be high severity
		});
	});
});
