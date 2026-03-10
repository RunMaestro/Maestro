/**
 * @vitest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SanitizedContentDiff } from '../../../renderer/components/SanitizedContentDiff';
import type { Finding } from '../../../renderer/components/FindingDetails';
import type { Theme } from '../../../renderer/types';

// Mock clipboard API
const mockClipboardWrite = vi.fn().mockResolvedValue(true);
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (...args: unknown[]) => mockClipboardWrite(...args),
}));

// Standard test theme
const testTheme: Theme = {
	name: 'Test Theme',
	isDark: true,
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		textMain: '#eee',
		textDim: '#888',
		border: '#333',
		accent: '#5c7cfa',
		success: '#51cf66',
		warning: '#fcc419',
		error: '#ff6b6b',
	},
};

// Sample findings for testing
const createFinding = (
	type: string,
	value: string,
	start: number,
	end: number,
	confidence: number,
	replacement?: string
): Finding => ({
	type,
	value,
	start,
	end,
	confidence,
	replacement,
});

describe('SanitizedContentDiff', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('Empty/No Changes State', () => {
		it('shows no changes message when findings have no replacements', () => {
			const findings: Finding[] = [createFinding('PII_EMAIL', 'test@example.com', 0, 16, 0.95)];

			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent="test@example.com"
					sanitizedContent="test@example.com"
					findings={findings}
				/>
			);

			expect(screen.getByText('No sanitization changes to display')).toBeInTheDocument();
		});

		it('shows no changes message when findings array is empty', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent="Hello world"
					sanitizedContent="Hello world"
					findings={[]}
				/>
			);

			expect(screen.getByText('No sanitization changes to display')).toBeInTheDocument();
		});
	});

	describe('Full Content Mode (with original/sanitized content)', () => {
		// Build token from pieces to avoid triggering secret scanners
		const fakeApiKey = ['sk', '1234567890abcdef'].join('-');
		const originalContent = `My email is test@example.com and my API key is ${fakeApiKey}`;
		const sanitizedContent = 'My email is [EMAIL_REDACTED] and my API key is [API_KEY_REDACTED]';
		const findings: Finding[] = [
			createFinding('PII_EMAIL', 'test@example.com', 12, 28, 0.98, '[EMAIL_REDACTED]'),
			createFinding('SECRET_API_KEY', fakeApiKey, 48, 66, 0.99, '[API_KEY_REDACTED]'),
		];

		it('renders header with change count', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			expect(screen.getByText('Content Changes')).toBeInTheDocument();
			expect(screen.getByText('(2 changes)')).toBeInTheDocument();
		});

		it('renders side-by-side view by default', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			expect(screen.getByText('Original')).toBeInTheDocument();
			expect(screen.getByText('Sanitized')).toBeInTheDocument();
		});

		it('switches to inline view when button clicked', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			const inlineButton = screen.getByText('Inline');
			fireEvent.click(inlineButton);

			expect(screen.getByText('Inline Diff')).toBeInTheDocument();
		});

		it('shows view mode toggle buttons', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			expect(screen.getByText('Side-by-Side')).toBeInTheDocument();
			expect(screen.getByText('Inline')).toBeInTheDocument();
		});

		it('displays footer with character counts', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			expect(screen.getByText(/Original: \d+ chars → Sanitized: \d+ chars/)).toBeInTheDocument();
		});

		it('shows legend with finding types', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			expect(screen.getByText('Legend (2 types)')).toBeInTheDocument();
			expect(screen.getByText('PII EMAIL')).toBeInTheDocument();
			expect(screen.getByText('SECRET API KEY')).toBeInTheDocument();
		});

		it('can toggle legend visibility', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			const legendButton = screen.getByText('Legend (2 types)');
			fireEvent.click(legendButton);

			// Legend should be collapsed now (types not visible)
			// Click again to expand
			fireEvent.click(legendButton);

			expect(screen.getByText('PII EMAIL')).toBeInTheDocument();
		});

		it('calls onClose when close button clicked', () => {
			const onClose = vi.fn();

			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
					onClose={onClose}
				/>
			);

			const closeButton = screen.getByTitle('Close diff view');
			fireEvent.click(closeButton);

			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('copies original content to clipboard', async () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			const copyButtons = screen.getAllByTitle('Copy original content');
			fireEvent.click(copyButtons[0]);

			await waitFor(() => {
				expect(mockClipboardWrite).toHaveBeenCalledWith(originalContent);
			});
		});

		it('copies sanitized content to clipboard', async () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent={originalContent}
					sanitizedContent={sanitizedContent}
					findings={findings}
				/>
			);

			const copyButton = screen.getByTitle('Copy sanitized content');
			fireEvent.click(copyButton);

			await waitFor(() => {
				expect(mockClipboardWrite).toHaveBeenCalledWith(sanitizedContent);
			});
		});
	});

	describe('Findings-Only Mode (without full content)', () => {
		const findings: Finding[] = [
			createFinding('PII_EMAIL', 'user@company.com', 100, 116, 0.95, '[EMAIL]'),
			createFinding('SECRET_TOKEN', 'ghp_xxxxxxxxxxxx', 200, 216, 0.99, '[TOKEN]'),
		];

		it('renders findings-only view when content not provided', () => {
			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('Content Changes')).toBeInTheDocument();
			expect(screen.getByText('(2 changes)')).toBeInTheDocument();
		});

		it('shows each finding with original and replacement', () => {
			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			// Finding types
			expect(screen.getByText('PII EMAIL')).toBeInTheDocument();
			expect(screen.getByText('SECRET TOKEN')).toBeInTheDocument();

			// Values
			expect(screen.getByText('user@company.com')).toBeInTheDocument();
			expect(screen.getByText('[EMAIL]')).toBeInTheDocument();
			expect(screen.getByText('ghp_xxxxxxxxxxxx')).toBeInTheDocument();
			expect(screen.getByText('[TOKEN]')).toBeInTheDocument();
		});

		it('shows confidence percentages', () => {
			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('95% confidence')).toBeInTheDocument();
			expect(screen.getByText('99% confidence')).toBeInTheDocument();
		});

		it('shows position information', () => {
			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('pos 100–116')).toBeInTheDocument();
			expect(screen.getByText('pos 200–216')).toBeInTheDocument();
		});

		it('copies all changes to clipboard', async () => {
			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			const copyAllButton = screen.getByText('Copy All');
			fireEvent.click(copyAllButton);

			await waitFor(() => {
				expect(mockClipboardWrite).toHaveBeenCalled();
				const calledWith = mockClipboardWrite.mock.calls[0][0];
				expect(calledWith).toContain('PII_EMAIL');
				expect(calledWith).toContain('user@company.com');
				expect(calledWith).toContain('[EMAIL]');
			});
		});
	});

	describe('Compact Mode', () => {
		const findings: Finding[] = [createFinding('PII_SSN', '123-45-6789', 0, 11, 0.99, '[SSN]')];

		it('renders in compact mode with smaller text', () => {
			const { container } = render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent="SSN: 123-45-6789"
					sanitizedContent="SSN: [SSN]"
					findings={findings}
					compact={true}
				/>
			);

			// In compact mode, legend should be collapsed by default
			expect(screen.getByText('Legend (1 types)')).toBeInTheDocument();
		});
	});

	describe('View Mode Prop', () => {
		const findings: Finding[] = [createFinding('PII_PHONE', '555-123-4567', 0, 12, 0.9, '[PHONE]')];

		it('respects initial inline viewMode prop', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent="Call 555-123-4567"
					sanitizedContent="Call [PHONE]"
					findings={findings}
					viewMode="inline"
				/>
			);

			expect(screen.getByText('Inline Diff')).toBeInTheDocument();
		});

		it('respects initial side-by-side viewMode prop', () => {
			render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent="Call 555-123-4567"
					sanitizedContent="Call [PHONE]"
					findings={findings}
					viewMode="side-by-side"
				/>
			);

			expect(screen.getByText('Original')).toBeInTheDocument();
			expect(screen.getByText('Sanitized')).toBeInTheDocument();
		});
	});

	describe('Max Height', () => {
		const findings: Finding[] = [
			createFinding('SECRET_KEY', 'very-long-secret-key', 0, 20, 0.95, '[REDACTED]'),
		];

		it('applies custom maxHeight', () => {
			const { container } = render(
				<SanitizedContentDiff
					theme={testTheme}
					originalContent="secret: very-long-secret-key"
					sanitizedContent="secret: [REDACTED]"
					findings={findings}
					maxHeight={200}
				/>
			);

			const scrollableAreas = container.querySelectorAll('[style*="max-height: 200px"]');
			expect(scrollableAreas.length).toBeGreaterThan(0);
		});
	});

	describe('Finding Type Colors', () => {
		it('applies correct colors for injection findings', () => {
			const findings: Finding[] = [
				createFinding('PROMPT_INJECTION', 'ignore previous instructions', 0, 28, 0.9, '[BLOCKED]'),
			];

			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('PROMPT INJECTION')).toBeInTheDocument();
		});

		it('applies correct colors for secret findings', () => {
			const findings: Finding[] = [
				createFinding('SECRET_API_KEY', 'sk-test123', 0, 10, 0.95, '[KEY]'),
			];

			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('SECRET API KEY')).toBeInTheDocument();
		});

		it('applies correct colors for PII findings', () => {
			const findings: Finding[] = [
				createFinding('PII_CREDIT_CARD', '4111111111111111', 0, 16, 0.99, '[CARD]'),
			];

			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('PII CREDIT CARD')).toBeInTheDocument();
		});
	});

	describe('Single vs Multiple Changes Text', () => {
		it('shows singular "change" for single finding', () => {
			const findings: Finding[] = [
				createFinding('PII_EMAIL', 'test@test.com', 0, 13, 0.9, '[EMAIL]'),
			];

			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('(1 change)')).toBeInTheDocument();
		});

		it('shows plural "changes" for multiple findings', () => {
			const findings: Finding[] = [
				createFinding('PII_EMAIL', 'test@test.com', 0, 13, 0.9, '[EMAIL]'),
				createFinding('PII_PHONE', '555-1234', 20, 28, 0.85, '[PHONE]'),
			];

			render(<SanitizedContentDiff theme={testTheme} findings={findings} />);

			expect(screen.getByText('(2 changes)')).toBeInTheDocument();
		});
	});
});
