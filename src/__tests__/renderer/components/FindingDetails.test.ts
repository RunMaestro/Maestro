/**
 * @file FindingDetails.test.ts
 * @description Tests for FindingDetails component logic
 *
 * Tests the component's:
 * - Finding type formatting
 * - Value masking for sensitive data
 * - Confidence level labeling
 * - Icon and color selection
 * - Documentation URL mapping
 */

import { describe, it, expect } from 'vitest';
import type { Finding } from '../../../renderer/components/FindingDetails';

// Helper function to format finding type (mirrors component logic)
function formatFindingType(type: string): string {
	return type.replace(/_/g, ' ');
}

// Helper function to mask values (mirrors component logic)
function maskValue(value: string, type: string): string {
	// For secrets, show first and last 4 chars with stars
	if (type.startsWith('SECRET_') || type.includes('PASSWORD') || type.includes('TOKEN')) {
		if (value.length <= 8) return '****';
		return value.slice(0, 4) + '****' + value.slice(-4);
	}
	// For credit cards, show last 4 digits
	if (type.includes('CREDIT_CARD')) {
		return '****' + value.slice(-4);
	}
	// For SSN, show format with X's
	if (type.includes('SSN')) {
		return 'XXX-XX-' + value.slice(-4);
	}
	// For email, show first char and domain
	if (type.includes('EMAIL') && value.includes('@')) {
		const [local, domain] = value.split('@');
		return local[0] + '***@' + domain;
	}
	// For phone, show last 4 digits
	if (type.includes('PHONE')) {
		return '***-***-' + value.slice(-4);
	}
	// Default: truncate long values
	if (value.length > 50) {
		return value.slice(0, 47) + '...';
	}
	return value;
}

// Helper function to get confidence label (mirrors component logic)
function getConfidenceLabel(confidence: number): { label: string; color: string } {
	if (confidence >= 0.9) return { label: 'Very High', color: '#ef4444' };
	if (confidence >= 0.7) return { label: 'High', color: '#f97316' };
	if (confidence >= 0.5) return { label: 'Medium', color: '#eab308' };
	return { label: 'Low', color: '#22c55e' };
}

// Documentation URL helper (mirrors component logic)
const DEFAULT_DOC_URL = 'https://docs.runmaestro.ai/security/llm-guard';

function getDocUrlForType(type: string): string {
	// Secrets
	if (type.includes('GITHUB')) return DEFAULT_DOC_URL + '#github-tokens';
	if (type.includes('AWS')) return DEFAULT_DOC_URL + '#aws-credentials';
	if (type.includes('OPENAI')) return DEFAULT_DOC_URL + '#api-keys';
	if (type.includes('CONNECTION_STRING') || type.includes('DATABASE'))
		return DEFAULT_DOC_URL + '#database-credentials';
	if (type.includes('PRIVATE_KEY') || type.includes('RSA'))
		return DEFAULT_DOC_URL + '#private-keys';
	if (type.includes('HIGH_ENTROPY')) return DEFAULT_DOC_URL + '#high-entropy-detection';
	if (type.startsWith('SECRET_')) return DEFAULT_DOC_URL + '#secrets';

	// PII
	if (type === 'PII_EMAIL') return DEFAULT_DOC_URL + '#email-addresses';
	if (type === 'PII_PHONE') return DEFAULT_DOC_URL + '#phone-numbers';
	if (type === 'PII_CREDIT_CARD') return DEFAULT_DOC_URL + '#credit-cards';
	if (type.includes('CRYPTO')) return DEFAULT_DOC_URL + '#cryptocurrency-wallets';
	if (type.startsWith('PII_')) return DEFAULT_DOC_URL + '#pii';

	// Prompt Injection
	if (type.includes('PROMPT_INJECTION')) return DEFAULT_DOC_URL + '#prompt-injection';

	// Structural
	if (type.startsWith('STRUCTURAL_')) return DEFAULT_DOC_URL + '#structural-analysis';

	// Invisible characters
	if (type.startsWith('INVISIBLE_')) return DEFAULT_DOC_URL + '#invisible-characters';

	// Encoding attacks
	if (type.startsWith('ENCODING_')) return DEFAULT_DOC_URL + '#encoding-attacks';

	// Banned content
	if (type.startsWith('BANNED_')) return DEFAULT_DOC_URL + '#banned-content';

	return DEFAULT_DOC_URL;
}

// Helper to get category type (mirrors component logic)
function getCategoryType(
	type: string
): 'injection' | 'secret' | 'pii' | 'invisible' | 'encoding' | 'structural' | 'banned' | 'other' {
	if (type.includes('INJECTION') || type.includes('JAILBREAK') || type.includes('LEAK')) {
		return 'injection';
	}
	if (
		type.startsWith('SECRET_') ||
		type.includes('PASSWORD') ||
		type.includes('TOKEN') ||
		type.includes('KEY')
	) {
		return 'secret';
	}
	if (type.startsWith('PII_')) {
		return 'pii';
	}
	if (type.startsWith('INVISIBLE_')) {
		return 'invisible';
	}
	if (type.startsWith('ENCODING_')) {
		return 'encoding';
	}
	if (type.startsWith('STRUCTURAL_')) {
		return 'structural';
	}
	if (type.startsWith('BANNED_')) {
		return 'banned';
	}
	return 'other';
}

describe('FindingDetails', () => {
	describe('formatFindingType', () => {
		it('replaces underscores with spaces', () => {
			expect(formatFindingType('SECRET_API_KEY')).toContain(' ');
			expect(formatFindingType('PII_EMAIL')).toContain(' ');
		});

		it('formats common finding types correctly', () => {
			expect(formatFindingType('SECRET_API_KEY')).toMatch(/SECRET API KEY/i);
			expect(formatFindingType('PII_EMAIL')).toMatch(/PII EMAIL/i);
			expect(formatFindingType('PROMPT_INJECTION')).toMatch(/PROMPT INJECTION/i);
		});
	});

	describe('maskValue', () => {
		describe('secret masking', () => {
			it('masks short secrets completely', () => {
				expect(maskValue('abc123', 'SECRET_API_KEY')).toBe('****');
				expect(maskValue('12345678', 'SECRET_PASSWORD')).toBe('****');
			});

			it('shows first and last 4 chars for longer secrets', () => {
				expect(maskValue('sk-1234567890abcdef', 'SECRET_API_KEY')).toBe('sk-1****cdef');
				expect(maskValue('myverylongpassword', 'SECRET_PASSWORD')).toBe('myve****word');
			});

			it('applies to all secret types', () => {
				expect(maskValue('ghp_abcdefghijklmnop', 'SECRET_GITHUB_TOKEN')).toBe('ghp_****mnop');
				expect(maskValue('AKIAIOSFODNN7EXAMPLE', 'SECRET_AWS_KEY')).toBe('AKIA****MPLE');
			});
		});

		describe('credit card masking', () => {
			it('shows only last 4 digits', () => {
				expect(maskValue('4111111111111111', 'PII_CREDIT_CARD')).toBe('****1111');
				expect(maskValue('5500000000000004', 'PII_CREDIT_CARD')).toBe('****0004');
			});
		});

		describe('SSN masking', () => {
			it('shows XXX-XX format with last 4 digits', () => {
				expect(maskValue('123-45-6789', 'PII_SSN')).toBe('XXX-XX-6789');
				expect(maskValue('987654321', 'PII_SSN')).toBe('XXX-XX-4321');
			});
		});

		describe('email masking', () => {
			it('shows first char and domain', () => {
				expect(maskValue('john.doe@example.com', 'PII_EMAIL')).toBe('j***@example.com');
				expect(maskValue('test@company.org', 'PII_EMAIL')).toBe('t***@company.org');
			});

			it('handles emails without @ symbol', () => {
				// Falls through to default behavior
				expect(maskValue('notanemail', 'PII_EMAIL')).toBe('notanemail');
			});
		});

		describe('phone masking', () => {
			it('shows only last 4 digits', () => {
				expect(maskValue('555-123-4567', 'PII_PHONE')).toBe('***-***-4567');
				expect(maskValue('18001234567', 'PII_PHONE')).toBe('***-***-4567');
			});
		});

		describe('default behavior', () => {
			it('truncates long values', () => {
				const longValue = 'a'.repeat(60);
				const masked = maskValue(longValue, 'UNKNOWN_TYPE');
				expect(masked.length).toBe(50);
				expect(masked.endsWith('...')).toBe(true);
			});

			it('returns short values unchanged', () => {
				expect(maskValue('short', 'UNKNOWN_TYPE')).toBe('short');
				expect(maskValue('medium value here', 'UNKNOWN_TYPE')).toBe('medium value here');
			});
		});
	});

	describe('getConfidenceLabel', () => {
		it('returns Very High for confidence >= 0.9', () => {
			expect(getConfidenceLabel(0.9).label).toBe('Very High');
			expect(getConfidenceLabel(0.95).label).toBe('Very High');
			expect(getConfidenceLabel(1.0).label).toBe('Very High');
		});

		it('returns High for confidence >= 0.7 and < 0.9', () => {
			expect(getConfidenceLabel(0.7).label).toBe('High');
			expect(getConfidenceLabel(0.8).label).toBe('High');
			expect(getConfidenceLabel(0.89).label).toBe('High');
		});

		it('returns Medium for confidence >= 0.5 and < 0.7', () => {
			expect(getConfidenceLabel(0.5).label).toBe('Medium');
			expect(getConfidenceLabel(0.6).label).toBe('Medium');
			expect(getConfidenceLabel(0.69).label).toBe('Medium');
		});

		it('returns Low for confidence < 0.5', () => {
			expect(getConfidenceLabel(0.49).label).toBe('Low');
			expect(getConfidenceLabel(0.3).label).toBe('Low');
			expect(getConfidenceLabel(0.1).label).toBe('Low');
		});

		it('uses appropriate colors', () => {
			expect(getConfidenceLabel(0.95).color).toBe('#ef4444'); // red
			expect(getConfidenceLabel(0.8).color).toBe('#f97316'); // orange
			expect(getConfidenceLabel(0.6).color).toBe('#eab308'); // yellow
			expect(getConfidenceLabel(0.3).color).toBe('#22c55e'); // green
		});
	});

	describe('getCategoryType', () => {
		it('identifies injection types', () => {
			expect(getCategoryType('PROMPT_INJECTION')).toBe('injection');
			expect(getCategoryType('PROMPT_INJECTION_IGNORE_INSTRUCTIONS')).toBe('injection');
			expect(getCategoryType('JAILBREAK_ATTEMPT')).toBe('injection');
			expect(getCategoryType('SYSTEM_PROMPT_LEAK')).toBe('injection');
			expect(getCategoryType('OUTPUT_INJECTION_SHELL_INJECTION')).toBe('injection');
		});

		it('identifies secret types', () => {
			expect(getCategoryType('SECRET_API_KEY')).toBe('secret');
			expect(getCategoryType('SECRET_AWS_ACCESS_KEY')).toBe('secret');
			expect(getCategoryType('SECRET_GITHUB_TOKEN')).toBe('secret');
			expect(getCategoryType('SECRET_OPENAI_KEY')).toBe('secret');
			expect(getCategoryType('SECRET_RSA_PRIVATE_KEY')).toBe('secret');
			expect(getCategoryType('SECRET_HIGH_ENTROPY_BASE64')).toBe('secret');
		});

		it('identifies PII types', () => {
			expect(getCategoryType('PII_EMAIL')).toBe('pii');
			expect(getCategoryType('PII_PHONE')).toBe('pii');
			expect(getCategoryType('PII_SSN')).toBe('pii');
			expect(getCategoryType('PII_CREDIT_CARD')).toBe('pii');
			expect(getCategoryType('PII_STREET_ADDRESS')).toBe('pii');
			expect(getCategoryType('PII_CRYPTO_BITCOIN_SEGWIT')).toBe('pii');
		});

		it('identifies invisible character types', () => {
			expect(getCategoryType('INVISIBLE_ZERO_WIDTH')).toBe('invisible');
			expect(getCategoryType('INVISIBLE_RTL_OVERRIDE')).toBe('invisible');
			expect(getCategoryType('INVISIBLE_HOMOGLYPH')).toBe('invisible');
			expect(getCategoryType('INVISIBLE_CONTROL_CHAR')).toBe('invisible');
		});

		it('identifies encoding attack types', () => {
			expect(getCategoryType('ENCODING_HTML_ENTITY')).toBe('encoding');
			expect(getCategoryType('ENCODING_URL_ENCODED')).toBe('encoding');
			expect(getCategoryType('ENCODING_UNICODE_ESCAPE')).toBe('encoding');
			expect(getCategoryType('ENCODING_PUNYCODE')).toBe('encoding');
		});

		it('identifies structural types', () => {
			expect(getCategoryType('STRUCTURAL_MULTIPLE_SYSTEM_SECTIONS')).toBe('structural');
			expect(getCategoryType('STRUCTURAL_JSON_PROMPT_TEMPLATE')).toBe('structural');
			expect(getCategoryType('STRUCTURAL_BASE64_BLOCK')).toBe('structural');
		});

		it('identifies banned content types', () => {
			expect(getCategoryType('BANNED_SUBSTRING')).toBe('banned');
			expect(getCategoryType('BANNED_TOPIC')).toBe('banned');
		});

		it('returns other for unknown types', () => {
			expect(getCategoryType('UNKNOWN_TYPE')).toBe('other');
			expect(getCategoryType('CUSTOM_FINDING')).toBe('other');
		});
	});

	describe('documentation URLs', () => {
		it('returns URLs for common finding types', () => {
			expect(getDocUrlForType('SECRET_GITHUB_TOKEN')).toContain('#github-tokens');
			expect(getDocUrlForType('SECRET_AWS_ACCESS_KEY')).toContain('#aws-credentials');
			expect(getDocUrlForType('PII_EMAIL')).toContain('#email-addresses');
			expect(getDocUrlForType('PROMPT_INJECTION_IGNORE_INSTRUCTIONS')).toContain(
				'#prompt-injection'
			);
		});

		it('uses runmaestro.ai documentation domain', () => {
			const types = ['SECRET_API_KEY', 'PII_EMAIL', 'PROMPT_INJECTION', 'STRUCTURAL_BASE64'];
			types.forEach((type) => {
				expect(getDocUrlForType(type)).toContain('docs.runmaestro.ai');
			});
		});

		it('has a default fallback URL', () => {
			expect(DEFAULT_DOC_URL).toBe('https://docs.runmaestro.ai/security/llm-guard');
		});

		it('returns category-specific URLs for different finding types', () => {
			expect(getDocUrlForType('SECRET_OPENAI_KEY')).toContain('#api-keys');
			expect(getDocUrlForType('SECRET_CONNECTION_STRING_POSTGRES')).toContain(
				'#database-credentials'
			);
			expect(getDocUrlForType('PII_CRYPTO_BITCOIN')).toContain('#cryptocurrency-wallets');
			expect(getDocUrlForType('STRUCTURAL_JSON_PROMPT_TEMPLATE')).toContain('#structural-analysis');
			expect(getDocUrlForType('INVISIBLE_ZERO_WIDTH')).toContain('#invisible-characters');
			expect(getDocUrlForType('ENCODING_HTML_ENTITY')).toContain('#encoding-attacks');
			expect(getDocUrlForType('BANNED_SUBSTRING')).toContain('#banned-content');
		});

		it('falls back to default URL for unknown types', () => {
			expect(getDocUrlForType('UNKNOWN_TYPE')).toBe(DEFAULT_DOC_URL);
			expect(getDocUrlForType('CUSTOM_FINDING')).toBe(DEFAULT_DOC_URL);
		});
	});

	describe('Finding type interface', () => {
		it('defines correct structure', () => {
			const finding: Finding = {
				type: 'SECRET_API_KEY',
				value: 'sk-test123456',
				start: 0,
				end: 12,
				confidence: 0.95,
			};

			expect(finding.type).toBeDefined();
			expect(finding.value).toBeDefined();
			expect(finding.start).toBeDefined();
			expect(finding.end).toBeDefined();
			expect(finding.confidence).toBeDefined();
		});

		it('supports optional replacement field', () => {
			const findingWithReplacement: Finding = {
				type: 'PII_EMAIL',
				value: 'test@example.com',
				start: 10,
				end: 27,
				confidence: 0.85,
				replacement: '[EMAIL_REDACTED]',
			};

			expect(findingWithReplacement.replacement).toBe('[EMAIL_REDACTED]');
		});

		it('allows finding without replacement', () => {
			const findingWithoutReplacement: Finding = {
				type: 'PROMPT_INJECTION',
				value: 'ignore previous instructions',
				start: 0,
				end: 28,
				confidence: 0.7,
			};

			expect(findingWithoutReplacement.replacement).toBeUndefined();
		});
	});
});
