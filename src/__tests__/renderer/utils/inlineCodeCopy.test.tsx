/**
 * Tests for inlineCodeCopy click/keydown handlers.
 *
 * Regression: when an inline <code> is nested inside an <a> (e.g. AI emits
 * `[\`file.md\`](file.md)`), clicking the <code> would copy + flash but the
 * browser's default link navigation would still run because the handler only
 * called stopPropagation, not preventDefault. That navigation could unload
 * the renderer to a non-existent in-bundle file (Linux: looks like a restart).
 */

import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock clipboard utility — the handler awaits this; default to success.
const mockSafeClipboardWrite = vi.fn().mockResolvedValue(true);
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (...args: unknown[]) => mockSafeClipboardWrite(...args),
}));

// Mock the center-flash store so we don't render the overlay during tests.
const mockNotifyCenterFlash = vi.fn();
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: (...args: unknown[]) => mockNotifyCenterFlash(...args),
}));

import {
	buildInlineCodeHandlers,
	extractInlineCodeText,
} from '../../../renderer/utils/inlineCodeCopy';

describe('inlineCodeCopy', () => {
	beforeEach(() => {
		mockSafeClipboardWrite.mockClear();
		mockNotifyCenterFlash.mockClear();
	});

	describe('extractInlineCodeText', () => {
		it('returns empty string for nullish/false children', () => {
			expect(extractInlineCodeText(null)).toBe('');
			expect(extractInlineCodeText(undefined)).toBe('');
			expect(extractInlineCodeText(false)).toBe('');
		});

		it('returns string for plain text children', () => {
			expect(extractInlineCodeText('hello')).toBe('hello');
			expect(extractInlineCodeText(42)).toBe('42');
		});

		it('joins arrays of children', () => {
			expect(extractInlineCodeText(['foo', 'bar', 'baz'])).toBe('foobarbaz');
		});

		it('recurses into React elements', () => {
			const tree = React.createElement('span', null, 'inner');
			expect(extractInlineCodeText(tree)).toBe('inner');
		});
	});

	describe('buildInlineCodeHandlers — onClick', () => {
		it('stops propagation and prevents default', () => {
			const handlers = buildInlineCodeHandlers('npm install');
			const e = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			} as unknown as React.MouseEvent;

			handlers.onClick(e);

			expect(e.preventDefault).toHaveBeenCalledTimes(1);
			expect(e.stopPropagation).toHaveBeenCalledTimes(1);
		});

		it('regression: prevents default link navigation when <code> is nested inside <a>', () => {
			// Reproduces the AI-emitted `[\`file.md\`](file.md)` shape.
			// Without preventDefault, the browser would resolve the relative href
			// against the current page and navigate, unloading the renderer.
			const handlers = buildInlineCodeHandlers('TEST-PLAN-0.16.15-RC.md');

			// Capture-phase listener on the document fires BEFORE the inline-code
			// handler — so by the time we inspect defaultPrevented after the click,
			// it should reflect the handler's preventDefault().
			let capturedEvent: Event | null = null;
			const captureListener = (e: Event) => {
				capturedEvent = e;
			};

			const linkClick = vi.fn();

			const { getByText } = render(
				React.createElement(
					'a',
					{
						href: 'TEST-PLAN-0.16.15-RC.md',
						onClick: linkClick,
					},
					React.createElement(
						'code',
						{
							onClick: handlers.onClick,
							role: 'button',
							tabIndex: 0,
						},
						'TEST-PLAN-0.16.15-RC.md'
					)
				)
			);

			document.addEventListener('click', captureListener, true);
			try {
				fireEvent.click(getByText('TEST-PLAN-0.16.15-RC.md'));
			} finally {
				document.removeEventListener('click', captureListener, true);
			}

			// The <code> handler should have prevented the click's default action
			// — that is what would otherwise let the browser perform <a> navigation.
			expect(capturedEvent).not.toBeNull();
			expect(capturedEvent!.defaultPrevented).toBe(true);

			// stopPropagation also fires, so the parent <a>'s React onClick (which
			// runs in the bubble phase) must NOT have been invoked.
			expect(linkClick).not.toHaveBeenCalled();
		});

		it('copies the extracted text to the clipboard', async () => {
			const handlers = buildInlineCodeHandlers('  some-command  ');
			const e = {
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			} as unknown as React.MouseEvent;

			handlers.onClick(e);
			// Allow the void copyInlineCode microtask to settle.
			await Promise.resolve();
			await Promise.resolve();

			expect(mockSafeClipboardWrite).toHaveBeenCalledWith('some-command');
		});
	});

	describe('buildInlineCodeHandlers — onKeyDown', () => {
		it('handles Enter and Space, prevents default + stops propagation', () => {
			const handlers = buildInlineCodeHandlers('value');
			for (const key of ['Enter', ' ']) {
				const e = {
					key,
					preventDefault: vi.fn(),
					stopPropagation: vi.fn(),
				} as unknown as React.KeyboardEvent;
				handlers.onKeyDown(e);
				expect(e.preventDefault).toHaveBeenCalledTimes(1);
				expect(e.stopPropagation).toHaveBeenCalledTimes(1);
			}
		});

		it('ignores other keys', () => {
			const handlers = buildInlineCodeHandlers('value');
			const e = {
				key: 'a',
				preventDefault: vi.fn(),
				stopPropagation: vi.fn(),
			} as unknown as React.KeyboardEvent;

			handlers.onKeyDown(e);

			expect(e.preventDefault).not.toHaveBeenCalled();
			expect(e.stopPropagation).not.toHaveBeenCalled();
		});
	});
});
