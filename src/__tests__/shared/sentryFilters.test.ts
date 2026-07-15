/**
 * Tests for shouldDropSentryEvent - the shared classifier used by both the
 * main and renderer Sentry initializers to suppress noise events we cannot
 * fix from inside the app.
 *
 * Strategy: one representative event per documented category gets dropped,
 * and a "real bug" exception passes through. Don't enumerate every regex -
 * the file's comment block is authoritative on which categories exist; we
 * just confirm the dispatch table works.
 */

import { describe, it, expect } from 'vitest';
import { shouldDropSentryEvent } from '../../shared/sentryFilters';

function exceptionEvent(type: string, value: string) {
	return { exception: { values: [{ type, value }] } };
}

describe('shouldDropSentryEvent', () => {
	describe('OS / filesystem environment', () => {
		it('drops ENOSPC out-of-disk errors', () => {
			expect(
				shouldDropSentryEvent(exceptionEvent('Error', 'ENOSPC: no space left on device, write'))
			).toBe(true);
		});

		it('drops EPIPE broken-pipe errors', () => {
			expect(shouldDropSentryEvent(exceptionEvent('Error', 'EPIPE: broken pipe, write'))).toBe(
				true
			);
		});

		it('drops Windows rename races (EPERM rename)', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						"EPERM: operation not permitted, rename 'C:\\foo.tmp' -> 'C:\\foo'"
					)
				)
			).toBe(true);
		});

		it('drops EBUSY/EPERM lstat on Windows system files', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('Error', "EBUSY: resource busy or locked, lstat 'C:\\pagefile.sys'")
				)
			).toBe(true);
		});

		it('does NOT drop EBUSY lstat on a user file', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						"EBUSY: resource busy or locked, lstat 'C:\\Users\\me\\report.pdf'"
					)
				)
			).toBe(false);
		});

		it('drops ETIMEDOUT scandir on network filesystems', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('Error', "ETIMEDOUT: connection timed out, scandir '/mnt/nfs/x'")
				)
			).toBe(true);
		});

		it('drops EISDIR watch errors', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('Error', "EISDIR: illegal operation on a directory, watch '/foo'")
				)
			).toBe(true);
		});
	});

	describe('IPC method noise (user-typed paths that do not exist)', () => {
		it('drops ENOENT bubbling up through fs:stat', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						"Error invoking remote method 'fs:stat': Error: ENOENT: no such file or directory, stat '/typo'"
					)
				)
			).toBe(true);
		});

		it('drops Path-not-found through shell:trashItem', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						"Error invoking remote method 'shell:trashItem': Error: Path does not exist: /typo"
					)
				)
			).toBe(true);
		});

		it('does NOT drop a generic IPC failure that is not a known noise pattern', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						"Error invoking remote method 'sessions:create': TypeError: Cannot read properties of undefined (reading 'name')"
					)
				)
			).toBe(false);
		});
	});

	describe('Native Chromium / Electron crashes', () => {
		it('drops partition_alloc:: crashes', () => {
			expect(shouldDropSentryEvent(exceptionEvent('partition_alloc::OomDeathTask', ''))).toBe(true);
		});

		it('drops blink:: crashes', () => {
			expect(shouldDropSentryEvent(exceptionEvent('blink::LocalFrameView::Layout', ''))).toBe(true);
		});

		it('drops rx::ContextGL:: crashes', () => {
			expect(shouldDropSentryEvent(exceptionEvent('rx::ContextGL::initialize', ''))).toBe(true);
		});

		it('drops unknown empty-value crashes', () => {
			expect(shouldDropSentryEvent(exceptionEvent('<unknown>', ''))).toBe(true);
		});
	});

	describe('External JS injection (antivirus / extensions corrupting the bundle)', () => {
		it('drops splash-stage ReferenceError for non-shipped symbol `i`', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('Error', 'Renderer error: [Splash] ReferenceError: i is not defined')
				)
			).toBe(true);
		});

		it('drops CSP-block errors from injected proxies', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('Error', 'Page failed to load: ERR_BLOCKED_BY_CSP at https://example')
				)
			).toBe(true);
		});
	});

	describe('Network / shell environment', () => {
		it('drops marketplace fetch failures when the user is offline', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'MarketplaceFetchError',
						'MarketplaceFetchError: Network error fetching index: fetch failed'
					)
				)
			).toBe(true);
		});

		// Regression (MAESTRO-MR): MarketplaceFetchError carries the original failure
		// as its `cause`, so Sentry's LinkedErrors integration ships TWO exception
		// values ordered root-cause-first. The classifier used to read values[0]
		// only, saw the bare `TypeError: fetch failed`, and let the event through -
		// the rule above looked correct but never fired in the field.
		it('drops marketplace fetch failures when Sentry expanded the cause chain', () => {
			expect(
				shouldDropSentryEvent({
					exception: {
						values: [
							{ type: 'TypeError', value: 'fetch failed' },
							{
								type: 'MarketplaceFetchError',
								value: 'Network error fetching document: fetch failed',
							},
						],
					},
				})
			).toBe(true);
		});

		// Regression (MAESTRO-TY): GitHub raw rate-limits playbook imports.
		it('drops marketplace fetches rejected by GitHub rate limiting or a 5xx', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('MarketplaceFetchError', 'Failed to fetch document: 429 Too Many Requests')
				)
			).toBe(true);
			expect(
				shouldDropSentryEvent(
					exceptionEvent('MarketplaceFetchError', 'Failed to fetch asset: 503 Service Unavailable')
				)
			).toBe(true);
		});

		it('does NOT drop a marketplace document that is genuinely missing', () => {
			expect(
				shouldDropSentryEvent(exceptionEvent('MarketplaceFetchError', 'Document not found: setup'))
			).toBe(false);
		});

		it('drops GitHub CLI network failures when the user is offline', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent(
						'Error',
						'Command failed: gh pr list\nerror connecting to api.github.com\ncheck your internet connection'
					)
				)
			).toBe(true);
		});

		it('drops shell PATH probe timeouts', () => {
			expect(shouldDropSentryEvent(exceptionEvent('Error', 'Timed out reading shell PATH'))).toBe(
				true
			);
		});
	});

	describe('legitimate errors', () => {
		it('does NOT drop a normal application exception', () => {
			expect(
				shouldDropSentryEvent(
					exceptionEvent('TypeError', "Cannot read properties of undefined (reading 'sessions')")
				)
			).toBe(false);
		});

		it('does NOT drop an event with no exception at all', () => {
			expect(shouldDropSentryEvent({})).toBe(false);
		});

		it('does NOT drop a custom domain error from our code', () => {
			expect(
				shouldDropSentryEvent(exceptionEvent('AgentSpawnError', 'Failed to spawn claude-code'))
			).toBe(false);
		});
	});
});
