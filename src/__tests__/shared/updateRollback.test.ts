/**
 * @file updateRollback.test.ts
 * @description Tests for the pure rollback helpers shared by the main process,
 * the Check for Updates modal, and `maestro-cli rollback`.
 */

import { describe, it, expect } from 'vitest';
import {
	isReleaseTag,
	isRollbackTarget,
	normalizeReleaseTag,
	releaseDisplayName,
	updaterChannelFile,
} from '../../shared/updateRollback';

describe('isReleaseTag', () => {
	it.each(['v1.0.3', '1.0.3', 'v1.1.2-RC', 'v0.18.8-rc.1'])('accepts %s', (tag) => {
		expect(isReleaseTag(tag)).toBe(true);
	});

	it.each(['', 'v1.0', 'latest', '../v1.0.3', 'v1.0.3/../../x', 'v1.0.3?x=1', 'v1.0.3 '])(
		'refuses %j, which must never reach a download URL',
		(tag) => {
			expect(isReleaseTag(tag)).toBe(false);
		}
	);
});

describe('normalizeReleaseTag', () => {
	it('adds the v prefix the release tags carry', () => {
		expect(normalizeReleaseTag('1.0.3')).toBe('v1.0.3');
		expect(normalizeReleaseTag(' v1.0.3 ')).toBe('v1.0.3');
	});
});

describe('isRollbackTarget', () => {
	it('is true only for a release strictly older than the running version', () => {
		expect(isRollbackTarget('v1.0.3', '1.0.4')).toBe(true);
		expect(isRollbackTarget('v1.0.4', '1.0.4')).toBe(false);
		expect(isRollbackTarget('v1.1.0', '1.0.4')).toBe(false);
	});

	it('orders a prerelease below its stable version', () => {
		expect(isRollbackTarget('v1.1.2-RC', '1.1.2')).toBe(true);
		expect(isRollbackTarget('v1.0.4', '1.1.2-RC')).toBe(true);
	});

	it('refuses a malformed tag even when it compares older', () => {
		expect(isRollbackTarget('v0.0.1/../..', '1.0.4')).toBe(false);
	});
});

describe('updaterChannelFile', () => {
	it('names the file electron-builder publishes per platform', () => {
		expect(updaterChannelFile('darwin', 'arm64')).toBe('latest-mac.yml');
		expect(updaterChannelFile('darwin', 'x64')).toBe('latest-mac.yml');
		expect(updaterChannelFile('win32', 'x64')).toBe('latest.yml');
		expect(updaterChannelFile('linux', 'x64')).toBe('latest-linux.yml');
		expect(updaterChannelFile('linux', 'arm64')).toBe('latest-linux-arm64.yml');
		expect(updaterChannelFile('freebsd', 'x64')).toBeNull();
	});
});

describe('releaseDisplayName', () => {
	it.each([
		['v1.0.4 | Red Pen', 'Red Pen'],
		['v1.0.4 - Red Pen', 'Red Pen'],
		['v1.0.4 Red Pen', 'Red Pen'],
		['Red Pen', 'Red Pen'],
	])('reads %j as %j', (name, expected) => {
		expect(releaseDisplayName(name, 'v1.0.4')).toBe(expected);
	});

	it('returns null when the name only repeats the tag', () => {
		expect(releaseDisplayName('v1.0.4', 'v1.0.4')).toBeNull();
		expect(releaseDisplayName('v1.0.4 |', 'v1.0.4')).toBeNull();
		expect(releaseDisplayName('', 'v1.0.4')).toBeNull();
	});
});
