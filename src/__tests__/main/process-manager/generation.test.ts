/**
 * Tests for src/main/process-manager/generation.ts
 *
 * The generation counter exists to answer one question an identity check
 * cannot: "has a newer spawn taken this session id?" - asked by a process whose
 * successor may itself already be gone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	nextSpawnGeneration,
	currentSpawnGeneration,
	isSupersededGeneration,
	resetSpawnGenerationsForTest,
} from '../../../main/process-manager/generation';

describe('process-manager/generation', () => {
	beforeEach(() => {
		resetSpawnGenerationsForTest();
	});

	it('starts at zero and counts up per session', () => {
		expect(currentSpawnGeneration('s1')).toBe(0);
		expect(nextSpawnGeneration('s1')).toBe(1);
		expect(nextSpawnGeneration('s1')).toBe(2);
		expect(currentSpawnGeneration('s1')).toBe(2);
	});

	it('counts independently per session id', () => {
		nextSpawnGeneration('s1');
		nextSpawnGeneration('s1');
		expect(nextSpawnGeneration('s2')).toBe(1);
		expect(currentSpawnGeneration('s1')).toBe(2);
	});

	it('marks an older generation superseded and the newest current', () => {
		const first = nextSpawnGeneration('s1');
		expect(isSupersededGeneration('s1', first)).toBe(false);

		const second = nextSpawnGeneration('s1');
		expect(isSupersededGeneration('s1', first)).toBe(true);
		expect(isSupersededGeneration('s1', second)).toBe(false);
	});

	// This is the whole point: the answer must survive the successor finishing.
	// An identity check against the process map starts passing again here, which
	// is how a predecessor's late `close` produced a second exit event.
	it('keeps a predecessor superseded after the successor is gone', () => {
		const predecessor = nextSpawnGeneration('s1');
		nextSpawnGeneration('s1'); // successor spawns, runs, and finishes

		expect(isSupersededGeneration('s1', predecessor)).toBe(true);
	});

	// A process registered by a path that does not stamp a generation must never
	// have its events silently dropped.
	it('treats an unstamped process as current', () => {
		nextSpawnGeneration('s1');
		nextSpawnGeneration('s1');
		expect(isSupersededGeneration('s1', undefined)).toBe(false);
	});

	it('does not supersede on a session that has never spawned', () => {
		expect(isSupersededGeneration('unknown', 1)).toBe(false);
	});
});
