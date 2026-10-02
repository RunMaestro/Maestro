import { describe, expect, it } from 'vitest';
import {
	checkFromVerdict,
	translatePianolaSandboxPath,
	validatePianolaVerdict,
	type PianolaSandboxObservation,
} from '../../../shared/pianola/pianola-validation';
import type { PianolaTaskValidation } from '../../../shared/pianola/pianola-tasks';

const spec: PianolaTaskValidation = {
	command: ['python3', '-m', 'pytest'],
	target: '/work',
	artifacts: ['/work/result.py'],
};
const success: PianolaSandboxObservation = {
	observed: true,
	returncode: 0,
	stdout: 'ok',
	stderr: '',
	timedOut: false,
	error: null,
};

describe('independent validation verdict', () => {
	it('verifies a successful oracle and records a passed check', () => {
		const result = validatePianolaVerdict(spec, success);
		expect(result.verdict).toBe('verified');
		expect(checkFromVerdict(result.verdict, result.reason, spec.command, 1, 2)).toEqual({
			name: 'independent-validation',
			status: 'passed',
			summary: result.reason,
			command: 'python3 -m pytest',
			startedAt: 1,
			completedAt: 2,
		});
	});
	it('rejects artifact escapes before any sandbox observation', () => {
		expect(
			validatePianolaVerdict(
				{ ...spec, artifacts: ['/work/../outside'] },
				{ ...success, observed: false }
			).verdict
		).toBe('failed');
		expect(validatePianolaVerdict({ ...spec, artifacts: ['../outside'] }, success).verdict).toBe(
			'failed'
		);
	});
	it('does not treat infrastructure faults as candidate failures', () => {
		expect(
			validatePianolaVerdict(spec, { ...success, observed: false, error: 'bwrap unavailable' })
				.verdict
		).toBe('unknown');
		expect(validatePianolaVerdict(spec, { ...success, timedOut: true }).verdict).toBe('unknown');
		for (const stderr of ['No such file or directory', 'not found', 'Permission denied'])
			expect(validatePianolaVerdict(spec, { ...success, returncode: 127, stderr }).verdict).toBe(
				'unknown'
			);
		expect(
			validatePianolaVerdict(spec, { ...success, returncode: 1, stderr: 'Read-only file system' })
				.verdict
		).toBe('unknown');
		expect(checkFromVerdict('unknown', 'sandbox unavailable', spec.command, 1, 2).status).toBe(
			'error'
		);
	});
	it('treats ordinary nonzero exit as a failed oracle', () => {
		expect(
			validatePianolaVerdict(spec, { ...success, returncode: 1, stderr: 'assertion failed' })
				.verdict
		).toBe('failed');
		expect(checkFromVerdict('failed', 'test failed', spec.command, 1, 2).status).toBe('failed');
	});
	it('translates Windows paths but leaves POSIX paths alone', () => {
		expect(translatePianolaSandboxPath('C:\\Users\\dev\\repo')).toBe('/mnt/c/Users/dev/repo');
		expect(translatePianolaSandboxPath('/tmp/work')).toBe('/tmp/work');
		expect(
			validatePianolaVerdict(
				{ ...spec, target: 'C:\\repo', artifacts: ['C:\\repo\\sub\\f'] },
				success
			).verdict
		).toBe('verified');
	});
});
