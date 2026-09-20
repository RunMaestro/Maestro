import { describe, it, expect } from 'vitest';
import {
	formatSteeringNotesBlock,
	normalizeSteeringNoteText,
	MAX_STEERING_NOTE_LENGTH,
	STEERING_BLOCK_START,
	STEERING_BLOCK_END,
	type AutoRunSteeringNote,
} from '../../shared/autorunSteering';

const note = (overrides: Partial<AutoRunSteeringNote> = {}): AutoRunSteeringNote => ({
	id: 'note-1',
	text: 'Important notice: Maestro error.',
	timestamp: Date.UTC(2026, 0, 1, 12, 0, 0),
	...overrides,
});

describe('normalizeSteeringNoteText', () => {
	it('trims surrounding whitespace', () => {
		expect(normalizeSteeringNoteText('  steer left \n')).toBe('steer left');
	});

	it('reads whitespace-only input as nothing to send', () => {
		expect(normalizeSteeringNoteText('   \n\t ')).toBe('');
	});

	it('caps a paste so one note cannot dominate the turn it was meant to nudge', () => {
		const long = 'x'.repeat(MAX_STEERING_NOTE_LENGTH + 500);
		expect(normalizeSteeringNoteText(long)).toHaveLength(MAX_STEERING_NOTE_LENGTH);
	});
});

describe('formatSteeringNotesBlock', () => {
	it('returns an empty string with no notes so callers can prepend unconditionally', () => {
		expect(formatSteeringNotesBlock([])).toBe('');
	});

	it('wraps the notes in the marked block', () => {
		const block = formatSteeringNotesBlock([note()]);
		expect(block.startsWith(STEERING_BLOCK_START)).toBe(true);
		expect(block.endsWith(STEERING_BLOCK_END)).toBe(true);
		expect(block).toContain('Important notice: Maestro error.');
	});

	it('numbers several notes in the order they were sent', () => {
		const block = formatSteeringNotesBlock([
			note({ id: 'a', text: 'first' }),
			note({ id: 'b', text: 'second' }),
		]);
		expect(block).toMatch(/1\. \([^)]+\) first/);
		expect(block).toMatch(/2\. \([^)]+\) second/);
		expect(block).toContain('Conductor steering notes');
	});

	it('uses the singular heading for one note', () => {
		expect(formatSteeringNotesBlock([note()])).toContain(
			'Conductor steering note - read this first'
		);
	});

	it('indents continuation lines so a multi-line note stays inside its own item', () => {
		const block = formatSteeringNotesBlock([note({ text: 'line one\nline two' })]);
		expect(block).toContain('\n   line two');
	});

	it('leaves template syntax in a note alone - it is the operator literal text', () => {
		const block = formatSteeringNotesBlock([note({ text: 'check {{GIT_BRANCH}}' })]);
		expect(block).toContain('check {{GIT_BRANCH}}');
	});
});
