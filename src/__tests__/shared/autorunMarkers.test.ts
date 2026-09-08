/**
 * The pill's whole value is the STATUS, not the presence of a marker. A gate
 * that will pause the run and one that has already been passed look identical
 * in the source text, so these tests pin the difference.
 */

import { describe, it, expect } from 'vitest';
import {
	scanMaestroMarkers,
	findPendingHitlGate,
	detectHaltMarker,
	findHaltMarker,
	hasMaestroMarker,
} from '../../shared/autorunMarkers';

describe('scanMaestroMarkers - HITL', () => {
	it('marks a gate live when an unchecked task sits below it', () => {
		const doc = [
			'<!-- MAESTRO:HITL reason="Add the API key" artifact=".env" -->',
			'- [ ] Send the welcome mail',
		].join('\n');
		expect(scanMaestroMarkers(doc)).toEqual([
			{
				kind: 'hitl',
				status: 'live',
				line: 0,
				scope: 'document',
				reason: 'Add the API key',
				artifact: '.env',
			},
		]);
	});

	it('marks a gate spent once the box below it is ticked', () => {
		// Identical source text to the live case apart from one character, which
		// is precisely why reading the raw document cannot answer the question.
		const doc = [
			'<!-- MAESTRO:HITL reason="Add the API key" -->',
			'- [x] Send the welcome mail',
		].join('\n');
		expect(scanMaestroMarkers(doc)[0].status).toBe('spent');
	});

	it('marks a trailing gate spent because it gates nothing', () => {
		const doc = ['- [ ] Real work', '<!-- MAESTRO:HITL reason="Nothing below me" -->'].join('\n');
		expect(scanMaestroMarkers(doc)[0].status).toBe('spent');
	});

	it('resolves a chain of gates together', () => {
		const doc = [
			'<!-- MAESTRO:HITL reason="One" -->',
			'<!-- MAESTRO:HITL reason="Two" -->',
			'- [ ] Task',
		].join('\n');
		expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['live', 'live']);
	});

	it('agrees with the engine about which gate pauses the run', () => {
		// The pill must not claim a gate is live that findPendingHitlGate ignores,
		// or the user removes the wrong marker.
		const doc = [
			'<!-- MAESTRO:HITL reason="Already done" -->',
			'- [x] Approved',
			'<!-- MAESTRO:HITL reason="Still waiting" -->',
			'- [ ] Blocked',
		].join('\n');
		const scanned = scanMaestroMarkers(doc);
		expect(scanned.map((m) => m.status)).toEqual(['spent', 'live']);
		expect(findPendingHitlGate(doc)?.reason).toBe('Still waiting');
	});

	it('supplies the default reason when the attribute is missing', () => {
		expect(scanMaestroMarkers('<!-- MAESTRO:HITL -->\n- [ ] x')[0].reason).toBe(
			'Human review requested'
		);
	});
});

describe('scanMaestroMarkers - halt', () => {
	it('always reports a halt as live, wherever it sits', () => {
		// A halt blocks the NEXT run from anywhere in the document, so unlike a
		// HITL gate there is no position that makes it inert.
		const doc = ['- [x] Done', '<!-- maestro:halt: build is broken -->'].join('\n');
		expect(scanMaestroMarkers(doc)).toEqual([
			{ kind: 'halt', status: 'live', line: 1, scope: 'document', reason: 'build is broken' },
		]);
	});

	it('handles the bare form with no reason', () => {
		expect(scanMaestroMarkers('<!-- maestro:halt -->')[0].reason).toBeUndefined();
	});
});

describe('scanMaestroMarkers - model', () => {
	it('marks a document hint live above the first unfinished task', () => {
		const doc = ['<!-- MAESTRO:MODEL tier="high" effort="high" -->', '- [ ] Design'].join('\n');
		const [marker] = scanMaestroMarkers(doc);
		expect(marker.status).toBe('live');
		expect(marker.hint).toMatchObject({ tier: 'high', effort: 'high' });
	});

	it('marks a hint spent once the run has moved past it', () => {
		// The next dispatch reads the LAST hint above the next unfinished task, so
		// a hint above an already-passed section no longer governs anything.
		const doc = [
			'<!-- MAESTRO:MODEL tier="high" -->',
			'- [ ] Next up',
			'<!-- MAESTRO:MODEL tier="low" -->',
			'- [ ] Later',
		].join('\n');
		expect(scanMaestroMarkers(doc).map((m) => m.status)).toEqual(['live', 'spent']);
	});

	it('marks an inline hint on a checked task spent', () => {
		const doc = ['- [x] Designed <!-- MAESTRO:MODEL tier="high" -->', '- [ ] Apply'].join('\n');
		const [marker] = scanMaestroMarkers(doc);
		expect(marker.status).toBe('spent');
		expect(marker.scope).toBe('task');
	});

	it('marks an inline hint on the next unfinished task live', () => {
		const doc = ['- [ ] Design <!-- MAESTRO:MODEL tier="high" -->'].join('\n');
		const [marker] = scanMaestroMarkers(doc);
		expect(marker.status).toBe('live');
		expect(marker.scope).toBe('task');
	});

	it('flags a misspelled value as invalid rather than showing it as live', () => {
		// The author believes this is doing something. Rendering it as a normal
		// hint would confirm that belief; the run will ignore it.
		const [marker] = scanMaestroMarkers('<!-- MAESTRO:MODEL tier="hgih" -->\n- [ ] x');
		expect(marker.status).toBe('invalid');
		expect(marker.hint?.invalid).toEqual([{ attribute: 'tier', value: 'hgih' }]);
	});
});

describe('scanMaestroMarkers - shared rules', () => {
	it('ignores every marker kind inside a fenced code block', () => {
		// Drawing a pill on a documentation example would state something false
		// about the document. The docs themselves contain all three forms.
		const doc = [
			'```markdown',
			'<!-- MAESTRO:HITL reason="example" -->',
			'<!-- maestro:halt: example -->',
			'<!-- MAESTRO:MODEL tier="high" -->',
			'```',
			'- [ ] The real task',
		].join('\n');
		expect(scanMaestroMarkers(doc)).toEqual([]);
	});

	it('returns markers in source order across kinds', () => {
		const doc = [
			'<!-- MAESTRO:MODEL tier="low" -->',
			'<!-- MAESTRO:HITL reason="check" -->',
			'- [ ] Task',
			'<!-- maestro:halt: stopped -->',
		].join('\n');
		expect(scanMaestroMarkers(doc).map((m) => m.kind)).toEqual(['model', 'hitl', 'halt']);
	});

	it('finds nothing in an ordinary document', () => {
		expect(scanMaestroMarkers('# Title\n\n- [ ] Do the thing')).toEqual([]);
		expect(hasMaestroMarker('- [ ] Do the thing')).toBe(false);
		expect(hasMaestroMarker('<!-- MAESTRO:MODEL tier="low" -->')).toBe(true);
	});

	it('does not fire on an unrelated HTML comment', () => {
		expect(scanMaestroMarkers('<!-- TODO: halt later -->\n- [ ] x')).toEqual([]);
	});
});

describe('relocated engine helpers still behave', () => {
	it('detectHaltMarker keeps its case-insensitive contract', () => {
		expect(detectHaltMarker('<!-- MAESTRO:HALT: nope -->')).toEqual({
			halted: true,
			reason: 'nope',
		});
		expect(detectHaltMarker('<!-- maestro:something -->')).toEqual({ halted: false });
	});

	it('detectHaltMarker ignores a fenced example, agreeing with the pill', () => {
		// Reversed deliberately: authoring agents document this syntax far more
		// often than executing agents mis-indent a real halt, and a halt that
		// blocked the run while drawing no pill was an invisible cause.
		const doc = ['```', '<!-- maestro:halt: documented, not requested -->', '```'].join('\n');
		expect(detectHaltMarker(doc).halted).toBe(false);
		expect(scanMaestroMarkers(doc)).toEqual([]);
	});
});

describe('halt marker - description vs instruction', () => {
	it('obeys a marker standing alone in the document body', () => {
		const doc = ['# Plan', '', '- [ ] Ship it', '', '<!-- maestro:halt: build is broken -->'].join(
			'\n'
		);
		expect(findHaltMarker(doc)).toEqual({ reason: 'build is broken', line: 4 });
		expect(detectHaltMarker(doc)).toEqual({ halted: true, reason: 'build is broken' });
	});

	it('ignores a marker quoted in inline backticks', () => {
		const doc = 'If the build is broken, write `<!-- maestro:halt: build broken -->` and stop.';
		expect(findHaltMarker(doc)).toBeNull();
		expect(detectHaltMarker(doc).halted).toBe(false);
	});

	it('ignores a marker riding a checkbox line', () => {
		const doc = '- [ ] Run the tests. On failure emit <!-- maestro:halt: tests failed -->';
		expect(findHaltMarker(doc)).toBeNull();
		expect(detectHaltMarker(doc).halted).toBe(false);
	});

	it('does not let a described halt block a playbook that has real work', () => {
		// The field bug: an authoring agent writes the marker as a conditional and
		// the playbook refuses to start before its first task ever runs.
		const doc = [
			'# Migration',
			'',
			'If any step below fails irrecoverably, halt with `<!-- maestro:halt: reason -->`.',
			'',
			'- [ ] Write the migration',
			'- [ ] Apply the migration <!-- maestro:halt: only if the DB is unreachable -->',
			'',
			'```markdown',
			'<!-- maestro:halt: brief reason here -->',
			'```',
		].join('\n');
		expect(detectHaltMarker(doc).halted).toBe(false);
	});

	it('reports the first obeyed marker line so the error can point at it', () => {
		const doc = ['a', '<!-- maestro:halt -->', '<!-- maestro:halt: second -->'].join('\n');
		expect(findHaltMarker(doc)).toEqual({ reason: undefined, line: 1 });
	});

	it('draws a spent pill for a described halt and a live one for a real halt', () => {
		const doc = [
			'- [ ] Apply it <!-- maestro:halt: describe only -->',
			'<!-- maestro:halt: really stopped -->',
		].join('\n');
		const halts = scanMaestroMarkers(doc).filter((m) => m.kind === 'halt');
		expect(halts).toEqual([
			expect.objectContaining({ status: 'spent', scope: 'task', line: 0 }),
			expect.objectContaining({ status: 'live', scope: 'document', line: 1 }),
		]);
	});

	it('draws no pill for a halt quoted in prose', () => {
		const doc = 'Emit `<!-- maestro:halt: reason -->` to stop the run.';
		expect(scanMaestroMarkers(doc)).toEqual([]);
	});
});
