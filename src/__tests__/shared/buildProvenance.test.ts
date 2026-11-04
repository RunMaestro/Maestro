/**
 * Tests for parseBuildProvenance - the gate that decides whether a build may
 * report crashes at all.
 *
 * The invariant that matters: NO DSN means NO reporting. Every malformed,
 * missing, or half-written provenance file has to land on `official: false` with
 * no `sentryDsn`, because the alternative is a fork build finding a usable
 * reporting address by accident - which is exactly the bug this file exists to
 * prevent.
 */

import { describe, it, expect } from 'vitest';
import { parseBuildProvenance, UNOFFICIAL_BUILD } from '../../shared/buildProvenance';

const DSN = 'https://abc123@o1.ingest.us.sentry.io/456';

describe('parseBuildProvenance', () => {
	it('accepts a well-formed official provenance file', () => {
		const result = parseBuildProvenance(
			JSON.stringify({ official: true, sentryDsn: DSN, generatedAt: '2026-09-21T00:00:00.000Z' })
		);
		expect(result.official).toBe(true);
		expect(result.sentryDsn).toBe(DSN);
		expect(result.generatedAt).toBe('2026-09-21T00:00:00.000Z');
	});

	it('accepts a fork build that supplied its own DSN but does not mark it official', () => {
		const result = parseBuildProvenance(JSON.stringify({ official: false, sentryDsn: DSN }));
		expect(result.official).toBe(false);
		expect(result.sentryDsn).toBe(DSN);
	});

	it('treats a missing file as unofficial with no DSN', () => {
		expect(parseBuildProvenance(null)).toEqual(UNOFFICIAL_BUILD);
		expect(parseBuildProvenance(undefined)).toEqual(UNOFFICIAL_BUILD);
		expect(parseBuildProvenance('')).toEqual(UNOFFICIAL_BUILD);
	});

	it('treats unparseable JSON as unofficial rather than throwing', () => {
		expect(parseBuildProvenance('{ not json')).toEqual(UNOFFICIAL_BUILD);
		// A torn write is the realistic corruption mode, not random bytes.
		expect(parseBuildProvenance('{"official": true, "sentryDsn": "https://abc')).toEqual(
			UNOFFICIAL_BUILD
		);
	});

	it('treats non-object JSON as unofficial', () => {
		expect(parseBuildProvenance('null')).toEqual(UNOFFICIAL_BUILD);
		expect(parseBuildProvenance('"a string"')).toEqual(UNOFFICIAL_BUILD);
		expect(parseBuildProvenance('42')).toEqual(UNOFFICIAL_BUILD);
	});

	it('refuses to report official when no DSN came with the claim', () => {
		// A file that says official but carries no address reports nowhere anyway.
		// Returning official:true there would tell callers reporting is live when it
		// is not, which is the one lie that makes this gate useless.
		expect(parseBuildProvenance(JSON.stringify({ official: true }))).toEqual(UNOFFICIAL_BUILD);
		expect(parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: '' }))).toEqual(
			UNOFFICIAL_BUILD
		);
		expect(parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: '   ' }))).toEqual(
			UNOFFICIAL_BUILD
		);
	});

	it('ignores a non-string DSN', () => {
		expect(parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: 42 }))).toEqual(
			UNOFFICIAL_BUILD
		);
		expect(
			parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: { url: DSN } }))
		).toEqual(UNOFFICIAL_BUILD);
	});

	it('requires `official` to be exactly true, not merely truthy', () => {
		// JSON from a hand-edited file could carry "true" or 1. Neither is our
		// pipeline's output, so neither earns the official tag.
		expect(
			parseBuildProvenance(JSON.stringify({ official: 'true', sentryDsn: DSN })).official
		).toBe(false);
		expect(parseBuildProvenance(JSON.stringify({ official: 1, sentryDsn: DSN })).official).toBe(
			false
		);
	});

	it('trims surrounding whitespace off the DSN', () => {
		expect(
			parseBuildProvenance(JSON.stringify({ official: true, sentryDsn: ` ${DSN}\n` })).sentryDsn
		).toBe(DSN);
	});

	it('drops a non-string generatedAt instead of passing it through', () => {
		const result = parseBuildProvenance(
			JSON.stringify({ official: true, sentryDsn: DSN, generatedAt: 1758412800000 })
		);
		expect(result.generatedAt).toBeUndefined();
	});
});
