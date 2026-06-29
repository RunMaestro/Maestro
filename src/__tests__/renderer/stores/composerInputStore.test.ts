/**
 * Tests for the composer draft store.
 *
 * This store holds the live AI / terminal input text that used to live in
 * useState inside useInputHandlers. It exists for keyboard performance: only the
 * memoized InputArea subscribes, so a keystroke no longer re-renders App. These
 * tests pin the setter / updater semantics the input subsystem relies on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
	useComposerInputStore,
	selectAiComposerValue,
	selectTerminalComposerValue,
} from '../../../renderer/stores/composerInputStore';

describe('composerInputStore', () => {
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', terminalValue: '' });
	});

	it('initializes both slices empty', () => {
		const s = useComposerInputStore.getState();
		expect(s.aiValue).toBe('');
		expect(s.terminalValue).toBe('');
	});

	it('setAiValue sets a literal value without touching the terminal slice', () => {
		useComposerInputStore.getState().setAiValue('hello AI');
		expect(useComposerInputStore.getState().aiValue).toBe('hello AI');
		expect(useComposerInputStore.getState().terminalValue).toBe('');
	});

	it('setTerminalValue sets a literal value without touching the AI slice', () => {
		useComposerInputStore.getState().setTerminalValue('ls -la');
		expect(useComposerInputStore.getState().terminalValue).toBe('ls -la');
		expect(useComposerInputStore.getState().aiValue).toBe('');
	});

	it('setAiValue accepts a functional updater that sees the previous value', () => {
		useComposerInputStore.getState().setAiValue('hello');
		useComposerInputStore.getState().setAiValue((prev) => prev + ' world');
		expect(useComposerInputStore.getState().aiValue).toBe('hello world');
	});

	it('setTerminalValue accepts a functional updater', () => {
		useComposerInputStore.getState().setTerminalValue('git');
		useComposerInputStore.getState().setTerminalValue((prev) => `${prev} status`);
		expect(useComposerInputStore.getState().terminalValue).toBe('git status');
	});

	it('selectors read the matching slice', () => {
		useComposerInputStore.setState({ aiValue: 'a', terminalValue: 't' });
		const s = useComposerInputStore.getState();
		expect(selectAiComposerValue(s)).toBe('a');
		expect(selectTerminalComposerValue(s)).toBe('t');
	});

	it('notifies subscribers only when a slice actually changes', () => {
		let calls = 0;
		const unsub = useComposerInputStore.subscribe(() => {
			calls += 1;
		});
		useComposerInputStore.getState().setAiValue('x');
		expect(calls).toBe(1);
		unsub();
	});
});
