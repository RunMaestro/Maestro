import { describe, expect, it } from 'vitest';
import { findPendingHitlGate } from '../../../../renderer/hooks/batch/batchUtils';

describe('findPendingHitlGate', () => {
	it('returns null when no marker is present', () => {
		const content = ['- [ ] task one', '- [ ] task two'].join('\n');
		expect(findPendingHitlGate(content)).toBeNull();
	});

	it('returns null when there are no tasks at all', () => {
		const content = ['# Heading', '<!-- MAESTRO:HITL reason="orphan" -->'].join('\n');
		expect(findPendingHitlGate(content)).toBeNull();
	});

	it('returns the marker when it precedes the first unchecked task', () => {
		const content = [
			'## Step 5: Review Specification',
			'',
			'<!-- MAESTRO:HITL reason="Spec ready for review" artifact=".maestro/outputs/SPEC.md" -->',
			'',
			'- [ ] Human has reviewed and approved the specification',
		].join('\n');

		const gate = findPendingHitlGate(content);
		expect(gate).not.toBeNull();
		expect(gate?.reason).toBe('Spec ready for review');
		expect(gate?.artifact).toBe('.maestro/outputs/SPEC.md');
	});

	it('returns null when an unchecked task appears before any marker', () => {
		const content = [
			'- [ ] earlier task without gate',
			'<!-- MAESTRO:HITL reason="later gate" -->',
			'- [ ] gated task',
		].join('\n');
		expect(findPendingHitlGate(content)).toBeNull();
	});

	it('treats a checked task as consuming the marker above it', () => {
		const content = [
			'<!-- MAESTRO:HITL reason="already approved" -->',
			'- [x] Human approved',
			'- [ ] follow-up work',
		].join('\n');
		expect(findPendingHitlGate(content)).toBeNull();
	});

	it('repauses on a fresh marker placed after a previously consumed one', () => {
		const content = [
			'<!-- MAESTRO:HITL reason="approved earlier" -->',
			'- [x] Approved spec',
			'<!-- MAESTRO:HITL reason="approve plan" artifact="PLAN.md" -->',
			'- [ ] Approve plan',
		].join('\n');
		const gate = findPendingHitlGate(content);
		expect(gate?.reason).toBe('approve plan');
		expect(gate?.artifact).toBe('PLAN.md');
	});

	it('returns the first marker when multiple appear before an unchecked task', () => {
		const content = [
			'<!-- MAESTRO:HITL reason="first" -->',
			'<!-- MAESTRO:HITL reason="second" -->',
			'- [ ] gated task',
		].join('\n');
		expect(findPendingHitlGate(content)?.reason).toBe('first');
	});

	it('handles missing artifact attribute', () => {
		const content = ['<!-- MAESTRO:HITL reason="just review" -->', '- [ ] approve'].join('\n');
		const gate = findPendingHitlGate(content);
		expect(gate?.reason).toBe('just review');
		expect(gate?.artifact).toBeUndefined();
	});

	it('falls back to a default reason when the attribute is missing', () => {
		const content = ['<!-- MAESTRO:HITL -->', '- [ ] approve'].join('\n');
		const gate = findPendingHitlGate(content);
		expect(gate?.reason).toBe('Human review requested');
	});

	it('ignores markers inside fenced code blocks', () => {
		const content = [
			'```markdown',
			'<!-- MAESTRO:HITL reason="documentation example" -->',
			'```',
			'- [ ] real task without a gate',
		].join('\n');
		expect(findPendingHitlGate(content)).toBeNull();
	});

	it('still detects markers outside fenced code blocks when an example exists inside one', () => {
		const content = [
			'```markdown',
			'<!-- MAESTRO:HITL reason="docs example" -->',
			'- [ ] example unchecked',
			'```',
			'<!-- MAESTRO:HITL reason="real gate" -->',
			'- [ ] real approval',
		].join('\n');
		expect(findPendingHitlGate(content)?.reason).toBe('real gate');
	});

	it('records the 0-indexed line number of the marker', () => {
		const content = [
			'# heading',
			'',
			'<!-- MAESTRO:HITL reason="check line" -->',
			'- [ ] gated',
		].join('\n');
		expect(findPendingHitlGate(content)?.line).toBe(2);
	});

	it('handles CRLF line endings', () => {
		const content = '<!-- MAESTRO:HITL reason="crlf" -->\r\n- [ ] gated\r\n';
		expect(findPendingHitlGate(content)?.reason).toBe('crlf');
	});
});
