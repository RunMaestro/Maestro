/**
 * @file SanitizedContentDiff.test.ts
 * @description Tests for SanitizedContentDiff component logic
 *
 * Tests the component's:
 * - Segment building from original content and findings
 * - Inline diff segment building
 * - Color coding by finding type
 * - Content reconstruction helpers
 */

import { describe, it, expect } from 'vitest';
import type { Finding } from '../../../renderer/components/FindingDetails';

// Sort findings by start position (mirrors component logic)
function sortFindingsByPosition(findings: Finding[]): Finding[] {
	return [...findings].sort((a, b) => a.start - b.start);
}

// Get highlight color for finding type (mirrors component logic)
function getHighlightColor(type: string): { bg: string; text: string } {
	// High severity: injection, jailbreak
	if (type.includes('INJECTION') || type.includes('JAILBREAK')) {
		return { bg: 'rgba(239, 68, 68, 0.3)', text: '#ef4444' };
	}
	// Secrets
	if (
		type.startsWith('SECRET_') ||
		type.includes('PASSWORD') ||
		type.includes('TOKEN') ||
		type.includes('KEY')
	) {
		return { bg: 'rgba(245, 158, 11, 0.3)', text: '#f59e0b' };
	}
	// PII
	if (type.startsWith('PII_')) {
		return { bg: 'rgba(139, 92, 246, 0.3)', text: '#8b5cf6' };
	}
	// Invisible characters
	if (type.startsWith('INVISIBLE_')) {
		return { bg: 'rgba(236, 72, 153, 0.3)', text: '#ec4899' };
	}
	// Default
	return { bg: 'rgba(59, 130, 246, 0.3)', text: '#3b82f6' };
}

// Segment type for rendering
interface TextSegment {
	type: 'normal' | 'removed' | 'added';
	text: string;
	findingType?: string;
	replacement?: string;
}

// Build segments from original content and findings (mirrors component logic)
function buildOriginalSegments(content: string, findings: Finding[]): TextSegment[] {
	const sortedFindings = sortFindingsByPosition(findings);
	const segments: TextSegment[] = [];
	let currentPos = 0;

	for (const finding of sortedFindings) {
		// Only process findings with replacements (i.e., actually sanitized)
		if (!finding.replacement) continue;

		// Add normal text before this finding
		if (finding.start > currentPos) {
			segments.push({
				type: 'normal',
				text: content.slice(currentPos, finding.start),
			});
		}

		// Add the removed (original) text
		if (finding.start >= 0 && finding.end <= content.length) {
			segments.push({
				type: 'removed',
				text: content.slice(finding.start, finding.end),
				findingType: finding.type,
				replacement: finding.replacement,
			});
		}

		currentPos = finding.end;
	}

	// Add remaining normal text
	if (currentPos < content.length) {
		segments.push({
			type: 'normal',
			text: content.slice(currentPos),
		});
	}

	return segments;
}

// Build segments from sanitized content and findings (mirrors component logic)
function buildSanitizedSegments(content: string, findings: Finding[]): TextSegment[] {
	const sortedFindings = sortFindingsByPosition(findings).filter((f) => f.replacement);

	if (sortedFindings.length === 0) {
		return [{ type: 'normal', text: content }];
	}

	const segments: TextSegment[] = [];
	let currentPos = 0;
	let offset = 0;

	for (const finding of sortedFindings) {
		if (!finding.replacement) continue;

		const originalLength = finding.end - finding.start;
		const replacementLength = finding.replacement.length;
		const adjustedStart = finding.start + offset;
		const adjustedEnd = adjustedStart + replacementLength;

		// Add normal text before this replacement
		if (adjustedStart > currentPos) {
			segments.push({
				type: 'normal',
				text: content.slice(currentPos, adjustedStart),
			});
		}

		// Add the replacement text (marked as added)
		if (adjustedStart >= 0 && adjustedEnd <= content.length) {
			segments.push({
				type: 'added',
				text: content.slice(adjustedStart, adjustedEnd),
				findingType: finding.type,
			});
		}

		currentPos = adjustedEnd;
		offset += replacementLength - originalLength;
	}

	// Add remaining normal text
	if (currentPos < content.length) {
		segments.push({
			type: 'normal',
			text: content.slice(currentPos),
		});
	}

	return segments;
}

// Inline diff segment (mirrors component logic)
interface InlineSegment {
	type: 'normal' | 'removed' | 'added';
	text: string;
	findingType?: string;
}

// Build inline diff segments (mirrors component logic)
function buildInlineSegments(
	originalContent: string,
	sanitizedContent: string,
	findings: Finding[]
): InlineSegment[] {
	const sortedFindings = sortFindingsByPosition(findings).filter((f) => f.replacement);

	if (sortedFindings.length === 0) {
		return [{ type: 'normal', text: originalContent }];
	}

	const segments: InlineSegment[] = [];
	let currentPos = 0;

	for (const finding of sortedFindings) {
		if (!finding.replacement) continue;

		// Add normal text before this finding
		if (finding.start > currentPos) {
			segments.push({
				type: 'normal',
				text: originalContent.slice(currentPos, finding.start),
			});
		}

		// Add the removed text (strikethrough)
		segments.push({
			type: 'removed',
			text: originalContent.slice(finding.start, finding.end),
			findingType: finding.type,
		});

		// Add the replacement text
		segments.push({
			type: 'added',
			text: finding.replacement,
			findingType: finding.type,
		});

		currentPos = finding.end;
	}

	// Add remaining normal text
	if (currentPos < originalContent.length) {
		segments.push({
			type: 'normal',
			text: originalContent.slice(currentPos),
		});
	}

	return segments;
}

// Reconstruct content from findings (mirrors SecurityEventsPanel helper)
function reconstructContentFromFindings(
	findings: Finding[],
	totalLength: number
): { original: string; sanitized: string } {
	if (findings.length === 0) {
		return { original: '', sanitized: '' };
	}

	const sorted = [...findings].sort((a, b) => a.start - b.start);
	const parts: string[] = [];
	const sanitizedParts: string[] = [];
	let lastEnd = 0;

	for (const finding of sorted) {
		if (finding.start > lastEnd) {
			const gapSize = Math.min(finding.start - lastEnd, 20);
			const gap = gapSize > 10 ? '... ' : '';
			parts.push(gap);
			sanitizedParts.push(gap);
		}

		parts.push(finding.value);
		sanitizedParts.push(finding.replacement || finding.value);
		lastEnd = finding.end;
	}

	if (lastEnd < totalLength) {
		const remaining = totalLength - lastEnd;
		if (remaining > 10) {
			parts.push(' ...');
			sanitizedParts.push(' ...');
		}
	}

	return {
		original: parts.join(''),
		sanitized: sanitizedParts.join(''),
	};
}

describe('SanitizedContentDiff', () => {
	describe('sortFindingsByPosition', () => {
		it('sorts findings by start position', () => {
			const findings: Finding[] = [
				{ type: 'PII_EMAIL', value: 'test@example.com', start: 50, end: 66, confidence: 0.9 },
				{ type: 'SECRET_KEY', value: 'sk-123', start: 10, end: 16, confidence: 0.95 },
				{ type: 'PII_PHONE', value: '555-1234', start: 30, end: 38, confidence: 0.8 },
			];

			const sorted = sortFindingsByPosition(findings);

			expect(sorted[0].start).toBe(10);
			expect(sorted[1].start).toBe(30);
			expect(sorted[2].start).toBe(50);
		});

		it('preserves original array', () => {
			const findings: Finding[] = [
				{ type: 'B', value: 'b', start: 20, end: 21, confidence: 0.9 },
				{ type: 'A', value: 'a', start: 10, end: 11, confidence: 0.9 },
			];

			sortFindingsByPosition(findings);

			// Original array should be unchanged
			expect(findings[0].start).toBe(20);
		});
	});

	describe('getHighlightColor', () => {
		it('returns red for injection types', () => {
			expect(getHighlightColor('PROMPT_INJECTION').text).toBe('#ef4444');
			expect(getHighlightColor('JAILBREAK_ATTEMPT').text).toBe('#ef4444');
			expect(getHighlightColor('OUTPUT_INJECTION_XSS').text).toBe('#ef4444');
		});

		it('returns orange/amber for secret types', () => {
			expect(getHighlightColor('SECRET_API_KEY').text).toBe('#f59e0b');
			expect(getHighlightColor('SECRET_PASSWORD').text).toBe('#f59e0b');
			expect(getHighlightColor('SECRET_GITHUB_TOKEN').text).toBe('#f59e0b');
		});

		it('returns purple for PII types', () => {
			expect(getHighlightColor('PII_EMAIL').text).toBe('#8b5cf6');
			expect(getHighlightColor('PII_PHONE').text).toBe('#8b5cf6');
			expect(getHighlightColor('PII_SSN').text).toBe('#8b5cf6');
		});

		it('returns pink for invisible character types', () => {
			expect(getHighlightColor('INVISIBLE_ZERO_WIDTH').text).toBe('#ec4899');
			expect(getHighlightColor('INVISIBLE_RTL').text).toBe('#ec4899');
		});

		it('returns blue for default/unknown types', () => {
			expect(getHighlightColor('UNKNOWN_TYPE').text).toBe('#3b82f6');
			expect(getHighlightColor('CUSTOM_FINDING').text).toBe('#3b82f6');
		});
	});

	describe('buildOriginalSegments', () => {
		it('builds segments for single finding', () => {
			const content = 'Hello test@example.com world';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 6,
					end: 22,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			const segments = buildOriginalSegments(content, findings);

			expect(segments).toHaveLength(3);
			expect(segments[0]).toEqual({ type: 'normal', text: 'Hello ' });
			expect(segments[1]).toEqual({
				type: 'removed',
				text: 'test@example.com',
				findingType: 'PII_EMAIL',
				replacement: '[EMAIL]',
			});
			expect(segments[2]).toEqual({ type: 'normal', text: ' world' });
		});

		it('builds segments for multiple findings', () => {
			const content = 'Contact: test@example.com or call 555-1234 done';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 9,
					end: 25,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
				{
					type: 'PII_PHONE',
					value: '555-1234',
					start: 34,
					end: 42,
					confidence: 0.85,
					replacement: '[PHONE]',
				},
			];

			const segments = buildOriginalSegments(content, findings);

			expect(segments).toHaveLength(5);
			expect(segments[0]).toEqual({ type: 'normal', text: 'Contact: ' });
			expect(segments[1].type).toBe('removed');
			expect(segments[2]).toEqual({ type: 'normal', text: ' or call ' });
			expect(segments[3].type).toBe('removed');
			expect(segments[4]).toEqual({ type: 'normal', text: ' done' });
		});

		it('ignores findings without replacement', () => {
			const content = 'This is a test';
			const findings: Finding[] = [
				{
					type: 'PROMPT_INJECTION',
					value: 'test',
					start: 10,
					end: 14,
					confidence: 0.7,
					// No replacement - detection only
				},
			];

			const segments = buildOriginalSegments(content, findings);

			// Should return just the normal text since there's no replacement
			expect(segments).toHaveLength(1);
			expect(segments[0]).toEqual({ type: 'normal', text: 'This is a test' });
		});

		it('handles finding at start of content', () => {
			const content = 'sk-secret123 is my key';
			const findings: Finding[] = [
				{
					type: 'SECRET_KEY',
					value: 'sk-secret123',
					start: 0,
					end: 12,
					confidence: 0.95,
					replacement: '[SECRET]',
				},
			];

			const segments = buildOriginalSegments(content, findings);

			expect(segments).toHaveLength(2);
			expect(segments[0].type).toBe('removed');
			expect(segments[1]).toEqual({ type: 'normal', text: ' is my key' });
		});

		it('handles finding at end of content', () => {
			const content = 'My email is test@example.com';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 12,
					end: 28,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			const segments = buildOriginalSegments(content, findings);

			expect(segments).toHaveLength(2);
			expect(segments[0]).toEqual({ type: 'normal', text: 'My email is ' });
			expect(segments[1].type).toBe('removed');
		});
	});

	describe('buildSanitizedSegments', () => {
		it('builds segments with replacement text', () => {
			const sanitizedContent = 'Hello [EMAIL] world';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 6,
					end: 22, // Original position (before sanitization)
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			const segments = buildSanitizedSegments(sanitizedContent, findings);

			expect(segments).toHaveLength(3);
			expect(segments[0]).toEqual({ type: 'normal', text: 'Hello ' });
			expect(segments[1].type).toBe('added');
			expect(segments[1].text).toBe('[EMAIL]');
			expect(segments[2]).toEqual({ type: 'normal', text: ' world' });
		});

		it('handles content with no replacements', () => {
			const content = 'No changes here';
			const findings: Finding[] = [
				{
					type: 'WARNING_TYPE',
					value: 'here',
					start: 11,
					end: 15,
					confidence: 0.5,
					// No replacement
				},
			];

			const segments = buildSanitizedSegments(content, findings);

			expect(segments).toHaveLength(1);
			expect(segments[0]).toEqual({ type: 'normal', text: 'No changes here' });
		});
	});

	describe('buildInlineSegments', () => {
		it('builds inline diff with removed and added segments', () => {
			const originalContent = 'Email: test@example.com';
			const sanitizedContent = 'Email: [EMAIL]';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 7,
					end: 23,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			const segments = buildInlineSegments(originalContent, sanitizedContent, findings);

			expect(segments).toHaveLength(3);
			expect(segments[0]).toEqual({ type: 'normal', text: 'Email: ' });
			expect(segments[1]).toEqual({
				type: 'removed',
				text: 'test@example.com',
				findingType: 'PII_EMAIL',
			});
			expect(segments[2]).toEqual({
				type: 'added',
				text: '[EMAIL]',
				findingType: 'PII_EMAIL',
			});
		});

		it('handles multiple inline replacements', () => {
			const originalContent = 'User: john@example.com, Phone: 555-1234';
			const sanitizedContent = 'User: [EMAIL], Phone: [PHONE]';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'john@example.com',
					start: 6,
					end: 22,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
				{
					type: 'PII_PHONE',
					value: '555-1234',
					start: 31,
					end: 39,
					confidence: 0.85,
					replacement: '[PHONE]',
				},
			];

			const segments = buildInlineSegments(originalContent, sanitizedContent, findings);

			// Should have: normal, removed, added, normal, removed, added
			expect(segments).toHaveLength(6);
			expect(segments[0].type).toBe('normal');
			expect(segments[1].type).toBe('removed');
			expect(segments[2].type).toBe('added');
			expect(segments[3].type).toBe('normal');
			expect(segments[4].type).toBe('removed');
			expect(segments[5].type).toBe('added');
		});

		it('returns original content when no replacements', () => {
			const originalContent = 'Nothing to change';
			const sanitizedContent = 'Nothing to change';
			const findings: Finding[] = [];

			const segments = buildInlineSegments(originalContent, sanitizedContent, findings);

			expect(segments).toHaveLength(1);
			expect(segments[0]).toEqual({ type: 'normal', text: 'Nothing to change' });
		});
	});

	describe('reconstructContentFromFindings', () => {
		it('reconstructs content from single finding', () => {
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 10,
					end: 26,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			const result = reconstructContentFromFindings(findings, 30);

			expect(result.original).toContain('test@example.com');
			expect(result.sanitized).toContain('[EMAIL]');
		});

		it('reconstructs content from multiple findings', () => {
			const findings: Finding[] = [
				{
					type: 'SECRET_KEY',
					value: 'sk-12345',
					start: 5,
					end: 13,
					confidence: 0.95,
					replacement: '[SECRET]',
				},
				{
					type: 'PII_EMAIL',
					value: 'user@example.com',
					start: 50,
					end: 66,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			const result = reconstructContentFromFindings(findings, 100);

			expect(result.original).toContain('sk-12345');
			expect(result.original).toContain('user@example.com');
			expect(result.sanitized).toContain('[SECRET]');
			expect(result.sanitized).toContain('[EMAIL]');
		});

		it('handles findings without replacement', () => {
			const findings: Finding[] = [
				{
					type: 'WARNING',
					value: 'suspicious text',
					start: 10,
					end: 25,
					confidence: 0.6,
					// No replacement
				},
			];

			const result = reconstructContentFromFindings(findings, 50);

			// Both should contain the original value when no replacement
			expect(result.original).toContain('suspicious text');
			expect(result.sanitized).toContain('suspicious text');
		});

		it('returns empty strings for no findings', () => {
			const result = reconstructContentFromFindings([], 100);

			expect(result.original).toBe('');
			expect(result.sanitized).toBe('');
		});

		it('adds gap placeholders for large gaps', () => {
			const findings: Finding[] = [
				{
					type: 'SECRET',
					value: 'secret1',
					start: 100,
					end: 107,
					confidence: 0.9,
					replacement: '[S1]',
				},
			];

			const result = reconstructContentFromFindings(findings, 200);

			// Should have gap placeholder since start > 10
			expect(result.original).toContain('...');
		});

		it('adds trailing placeholder for remaining content', () => {
			const findings: Finding[] = [
				{
					type: 'SECRET',
					value: 'secret',
					start: 0,
					end: 6,
					confidence: 0.9,
					replacement: '[SECRET]',
				},
			];

			const result = reconstructContentFromFindings(findings, 100);

			// Should have trailing placeholder since (100 - 6) > 10
			expect(result.original).toContain('...');
		});
	});

	describe('edge cases', () => {
		it('handles overlapping findings', () => {
			const content = 'test@example.com';
			const findings: Finding[] = [
				{
					type: 'PII_EMAIL',
					value: 'test@example.com',
					start: 0,
					end: 16,
					confidence: 0.9,
					replacement: '[EMAIL]',
				},
			];

			// Should not throw
			const segments = buildOriginalSegments(content, findings);
			expect(segments.length).toBeGreaterThan(0);
		});

		it('handles empty content', () => {
			const segments = buildOriginalSegments('', []);
			expect(segments).toHaveLength(0);
		});

		it('handles findings with zero-length value', () => {
			const content = 'Some text';
			const findings: Finding[] = [
				{
					type: 'ZERO_LENGTH',
					value: '',
					start: 5,
					end: 5,
					confidence: 0.5,
					replacement: '[MARKER]',
				},
			];

			// Should handle without error
			const segments = buildOriginalSegments(content, findings);
			expect(segments).toBeDefined();
		});
	});
});
