/**
 * The policy is the only thing that decides whether an unattended Auto Run
 * restarts itself, so the cases that matter are the ones where a config arrives
 * incomplete or hostile: absent fields must give the documented defaults (the
 * feature ships ON, so "absent" cannot mean "off"), and out-of-range numbers
 * must clamp rather than schedule a resume loop that fires every few
 * milliseconds.
 */

import { describe, it, expect } from 'vitest';
import {
	AUTO_RESUME_DEFAULT_MINUTES,
	AUTO_RESUME_DEFAULT_MAX_ATTEMPTS,
	AUTO_RESUME_MIN_MINUTES,
	AUTO_RESUME_MAX_MINUTES,
	AUTO_RESUME_MIN_ATTEMPTS,
	AUTO_RESUME_MAX_ATTEMPTS,
	autoResumeEnabled,
	clampAutoResumeMinutes,
	clampMaxAutoResumes,
	resolveAutoResumePolicy,
} from '../../shared/autorunAutoResume';

describe('autoResumeEnabled', () => {
	it('treats an absent flag as ON so an existing run is protected', () => {
		expect(autoResumeEnabled(undefined)).toBe(true);
		expect(autoResumeEnabled(true)).toBe(true);
	});

	it('only an explicit false opts out', () => {
		expect(autoResumeEnabled(false)).toBe(false);
	});
});

describe('clampAutoResumeMinutes', () => {
	it('keeps a value inside the range', () => {
		expect(clampAutoResumeMinutes(12)).toBe(12);
	});

	it('clamps to the bounds rather than rejecting', () => {
		expect(clampAutoResumeMinutes(0)).toBe(AUTO_RESUME_MIN_MINUTES);
		expect(clampAutoResumeMinutes(-30)).toBe(AUTO_RESUME_MIN_MINUTES);
		expect(clampAutoResumeMinutes(10_000)).toBe(AUTO_RESUME_MAX_MINUTES);
	});

	it('falls back to the default for junk, which is what an empty input sends', () => {
		expect(clampAutoResumeMinutes(NaN)).toBe(AUTO_RESUME_DEFAULT_MINUTES);
		expect(clampAutoResumeMinutes(undefined)).toBe(AUTO_RESUME_DEFAULT_MINUTES);
		expect(clampAutoResumeMinutes('five')).toBe(AUTO_RESUME_DEFAULT_MINUTES);
	});

	it('rounds a fractional value to whole minutes', () => {
		expect(clampAutoResumeMinutes(7.4)).toBe(7);
	});
});

describe('clampMaxAutoResumes', () => {
	it('clamps to the bounds', () => {
		expect(clampMaxAutoResumes(0)).toBe(AUTO_RESUME_MIN_ATTEMPTS);
		expect(clampMaxAutoResumes(9999)).toBe(AUTO_RESUME_MAX_ATTEMPTS);
	});

	it('falls back to the default for junk', () => {
		expect(clampMaxAutoResumes(undefined)).toBe(AUTO_RESUME_DEFAULT_MAX_ATTEMPTS);
	});
});

describe('resolveAutoResumePolicy', () => {
	it('gives the documented defaults for a config that says nothing', () => {
		expect(resolveAutoResumePolicy({})).toEqual({
			delayMs: AUTO_RESUME_DEFAULT_MINUTES * 60_000,
			maxAttempts: AUTO_RESUME_DEFAULT_MAX_ATTEMPTS,
		});
	});

	it('gives the same defaults for a missing config entirely', () => {
		// A run launched from the CLI, or restored from a playbook written before
		// this existed, must still auto-resume.
		expect(resolveAutoResumePolicy(undefined)).toEqual({
			delayMs: AUTO_RESUME_DEFAULT_MINUTES * 60_000,
			maxAttempts: AUTO_RESUME_DEFAULT_MAX_ATTEMPTS,
		});
		expect(resolveAutoResumePolicy(null)).not.toBeNull();
	});

	it('returns null when the run opted out', () => {
		expect(resolveAutoResumePolicy({ autoResumeOnError: false })).toBeNull();
	});

	it('converts minutes to milliseconds', () => {
		expect(resolveAutoResumePolicy({ autoResumeAfterMin: 3 })?.delayMs).toBe(180_000);
	});

	it('clamps a config that would otherwise hammer the run', () => {
		const policy = resolveAutoResumePolicy({ autoResumeAfterMin: 0, maxAutoResumes: 100_000 });
		expect(policy?.delayMs).toBe(AUTO_RESUME_MIN_MINUTES * 60_000);
		expect(policy?.maxAttempts).toBe(AUTO_RESUME_MAX_ATTEMPTS);
	});
});
