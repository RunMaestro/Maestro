/**
 * Tests for src/renderer/utils/shellCommandInput.ts
 *
 * Command mode is explicit state, so this module is down to two jobs: deciding
 * when the `!` gesture should switch the composer into it (consuming the bang),
 * and unwrapping the `\!` escape for messages that really do start with a bang.
 */

import { describe, test, expect } from 'vitest';
import {
	detectCommandModeEntry,
	isAiCommandMode,
	isShellCommandMode,
	nextComposerCommandMode,
	normalizeComposerCommandMode,
	previousComposerCommandMode,
	stripShellCommandEscape,
} from '../../../renderer/utils/shellCommandInput';

describe('detectCommandModeEntry', () => {
	test('enters on a bang typed into an empty composer, consuming the bang', () => {
		expect(detectCommandModeEntry('', '!')).toBe('');
	});

	test('keeps whatever followed the bang in a paste', () => {
		expect(detectCommandModeEntry('', '!git status')).toBe('git status');
	});

	test('treats a whitespace-only composer as empty', () => {
		expect(detectCommandModeEntry('   ', '!ls')).toBe('ls');
		expect(detectCommandModeEntry('\n', '!ls')).toBe('ls');
	});

	test('preserves leading whitespace around the consumed bang', () => {
		expect(detectCommandModeEntry('', '  !ls')).toBe('  ls');
	});

	test('does not enter when the composer already had a message', () => {
		// Caret moved to the start of an in-progress message and `!` typed: that
		// must stay a message, not silently become a shell command.
		expect(detectCommandModeEntry('deploy the site', '!deploy the site')).toBeNull();
	});

	test('does not enter on a bang that is not leading', () => {
		expect(detectCommandModeEntry('', 'do it now!')).toBeNull();
	});

	test('does not enter for ordinary text', () => {
		expect(detectCommandModeEntry('', 'fix the login bug')).toBeNull();
		expect(detectCommandModeEntry('', '')).toBeNull();
	});

	test('does not enter for the escape form', () => {
		// `\!` is how you send a literal leading bang to the agent.
		expect(detectCommandModeEntry('', '\\!important')).toBeNull();
	});
});

describe('stripShellCommandEscape', () => {
	test('unwraps a leading escaped bang', () => {
		expect(stripShellCommandEscape('\\!important message')).toBe('!important message');
	});

	test('preserves leading whitespace while unwrapping', () => {
		expect(stripShellCommandEscape('  \\!hey')).toBe('  !hey');
	});

	test('leaves ordinary messages untouched', () => {
		expect(stripShellCommandEscape('fix the login bug')).toBe('fix the login bug');
	});

	test('only strips the leading escape, not later ones', () => {
		expect(stripShellCommandEscape('\\!a and \\!b')).toBe('!a and \\!b');
	});

	test('leaves a non-leading backslash-bang untouched', () => {
		expect(stripShellCommandEscape('echo \\!x')).toBe('echo \\!x');
	});
});

describe('the bang ladder', () => {
	test('climbs agent -> shell -> ai and stops there', () => {
		expect(nextComposerCommandMode('off')).toBe('shell');
		expect(nextComposerCommandMode('shell')).toBe('ai');
		// No rung above AI command mode, so the bang stays in the request text.
		expect(nextComposerCommandMode('ai')).toBeNull();
	});

	test('descends ai -> shell -> agent and floors at agent', () => {
		expect(previousComposerCommandMode('ai')).toBe('shell');
		expect(previousComposerCommandMode('shell')).toBe('off');
		expect(previousComposerCommandMode('off')).toBe('off');
	});

	test('only the shell rung reports as a shell command line', () => {
		expect(isShellCommandMode('shell')).toBe(true);
		expect(isShellCommandMode('ai')).toBe(false);
		expect(isAiCommandMode('ai')).toBe(true);
		expect(isAiCommandMode('shell')).toBe(false);
	});
});

describe('normalizeComposerCommandMode', () => {
	test('reads the legacy boolean encoding as the shell rung', () => {
		// Tabs written before AI command mode existed stored `true` for what is
		// now 'shell'. Those drafts must still route to the shell after an update.
		expect(normalizeComposerCommandMode(true)).toBe('shell');
		expect(normalizeComposerCommandMode(false)).toBe('off');
	});

	test('passes through the current encoding', () => {
		expect(normalizeComposerCommandMode('shell')).toBe('shell');
		expect(normalizeComposerCommandMode('ai')).toBe('ai');
		expect(normalizeComposerCommandMode('off')).toBe('off');
	});

	test('falls back to ordinary chat for anything unrecognised', () => {
		// A corrupt value must land the user in chat, never in a shell.
		expect(normalizeComposerCommandMode(undefined)).toBe('off');
		expect(normalizeComposerCommandMode(null)).toBe('off');
		expect(normalizeComposerCommandMode('bogus')).toBe('off');
		expect(normalizeComposerCommandMode(1)).toBe('off');
	});
});
