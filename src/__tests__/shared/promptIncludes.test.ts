import { describe, it, expect, vi } from 'vitest';
import {
	MAX_PROMPT_INCLUDE_DEPTH,
	findPromptIncludeNames,
	resolvePromptIncludes,
} from '../../shared/promptIncludes';

const loader = (files: Record<string, string>) => (name: string) => files[name] ?? null;

describe('findPromptIncludeNames', () => {
	it('lists each referenced include once, in order', () => {
		expect(findPromptIncludeNames('{{INCLUDE:_a}} x {{INCLUDE:_b}} {{INCLUDE:_a}}')).toEqual([
			'_a',
			'_b',
		]);
	});

	it('returns nothing for content without directives', () => {
		expect(findPromptIncludeNames('plain {{REF:_a}} text')).toEqual([]);
	});
});

describe('resolvePromptIncludes', () => {
	it('inlines nested includes', () => {
		const out = resolvePromptIncludes('top {{INCLUDE:_a}}', {
			load: loader({ _a: 'A {{INCLUDE:_b}}', _b: 'B' }),
		});
		expect(out).toBe('top A B');
	});

	it('expands every occurrence, not just the first', () => {
		const out = resolvePromptIncludes('{{INCLUDE:_a}}/{{INCLUDE:_a}}', {
			load: loader({ _a: 'A' }),
		});
		expect(out).toBe('A/A');
	});

	it('leaves a missing include in place and reports it', () => {
		const onMissing = vi.fn();
		const out = resolvePromptIncludes('x {{INCLUDE:_gone}}', { load: loader({}), onMissing });
		expect(out).toBe('x {{INCLUDE:_gone}}');
		expect(onMissing).toHaveBeenCalledWith('_gone');
	});

	it('stops a cycle, including a prompt that includes itself', () => {
		const onCycle = vi.fn();
		const out = resolvePromptIncludes('{{INCLUDE:_a}}', {
			load: loader({ _a: 'A {{INCLUDE:root}}' }),
			rootId: 'root',
			onCycle,
		});
		expect(out).toBe('A {{INCLUDE:root}}');
		expect(onCycle).toHaveBeenCalledWith('root', ['root', '_a']);
	});

	it(`stops expanding past depth ${MAX_PROMPT_INCLUDE_DEPTH}`, () => {
		const out = resolvePromptIncludes('{{INCLUDE:_1}}', {
			load: loader({
				_1: '1{{INCLUDE:_2}}',
				_2: '2{{INCLUDE:_3}}',
				_3: '3{{INCLUDE:_4}}',
				_4: '4',
			}),
		});
		expect(out).toBe('123{{INCLUDE:_4}}');
	});
});
