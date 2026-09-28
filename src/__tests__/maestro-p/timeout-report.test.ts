/**
 * @file timeout-report.test.ts
 * @description Tests for src/maestro-p/timeout-report.ts stderr reports.
 *
 * An idle timeout (exit 3) used to write nothing to stderr, so a turn parked on
 * a permission prompt or a modal left no evidence behind (issue #1579). Every
 * timeout path now dumps the screen tail through `formatScreenTailReport`.
 */

import { describe, it, expect } from 'vitest';

import { formatScreenTailReport, idleTimeoutMessage } from '../../maestro-p/timeout-report';

describe('formatScreenTailReport', () => {
	it('writes the message, then the screen tail under the shared header', () => {
		const report = formatScreenTailReport(
			'something stalled.',
			'Do you want to proceed?\n❯ 1. Yes'
		);
		expect(report).toBe(
			'maestro-p: something stalled.\n' +
				'maestro-p: last screen at timeout (ANSI-stripped tail):\n' +
				'Do you want to proceed?\n❯ 1. Yes\n'
		);
	});

	it('still ends with a newline when the screen is empty', () => {
		expect(formatScreenTailReport('x', '').endsWith('tail):\n\n')).toBe(true);
	});
});

describe('idleTimeoutMessage', () => {
	it('reports the observed silence and the --max-wait budget', () => {
		const message = idleTimeoutMessage(961_400, 900);
		expect(message).toContain('no transcript output for 961s');
		expect(message).toContain('--max-wait 900s');
		expect(message).toContain('Failing with timeout.');
	});
});
