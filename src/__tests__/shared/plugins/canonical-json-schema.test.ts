import { describe, expect, it } from 'vitest';
import { compileCanonicalJsonSchema } from '../../../shared/plugins/canonical-json-schema';

describe('compileCanonicalJsonSchema', () => {
	it('validates nested values and rejects wrong types and extra properties', () => {
		const validator = compileCanonicalJsonSchema({
			type: 'object',
			additionalProperties: false,
			required: ['items'],
			properties: {
				items: {
					type: 'array',
					minItems: 1,
					maxItems: 2,
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['name', 'count'],
						properties: {
							name: { type: 'string', minLength: 1, maxLength: 3, pattern: '^[A-Z]+$' },
							count: { type: 'integer', minimum: 1, maximum: 3 },
						},
					},
				},
			},
		});

		expect(validator).not.toBeNull();
		expect(validator?.validate({ items: [{ name: 'AB', count: 2 }] })).toBe(true);
		expect(validator?.validate({ items: [{ name: 'ab', count: 2 }] })).toBe(false);
		expect(validator?.validate({ items: [{ name: 'ABCD', count: 2 }] })).toBe(false);
		expect(validator?.validate({ items: [{ name: 'AB', count: 2.5 }] })).toBe(false);
		expect(validator?.validate({ items: [{ name: 'AB', count: 4 }] })).toBe(false);
		expect(validator?.validate({ items: [{ name: 'AB', count: 2, extra: true }] })).toBe(false);
		expect(validator?.validate({ items: [] })).toBe(false);
		expect(
			validator?.validate({
				items: [
					{ name: 'AB', count: 2 },
					{ name: 'CD', count: 3 },
					{ name: 'EF', count: 1 },
				],
			})
		).toBe(false);
	});

	it('supports scalar const and enum constraints', () => {
		const validator = compileCanonicalJsonSchema({
			type: 'object',
			additionalProperties: false,
			required: ['mode', 'version'],
			properties: {
				mode: { type: 'string', enum: ['safe', 'fast'] },
				version: { const: 1 },
			},
		});
		expect(validator?.validate({ mode: 'safe', version: 1 })).toBe(true);
		expect(validator?.validate({ mode: 'unsafe', version: 1 })).toBe(false);
		expect(validator?.validate({ mode: 'safe', version: 2 })).toBe(false);
	});

	it('counts Unicode scalars and UTF-8 bytes independently', () => {
		const validator = compileCanonicalJsonSchema({
			type: 'string',
			minLength: 1,
			maxLength: 1,
			minBytes: 4,
			maxBytes: 4,
		});
		expect(validator?.validate('😀')).toBe(true);
		expect(validator?.validate('é')).toBe(false);
		expect(validator?.validate('ab')).toBe(false);
	});

	it('fails closed for malformed or explosive schemas and bounded values', () => {
		expect(
			compileCanonicalJsonSchema({
				type: 'object',
				properties: { bad: { unknownKeyword: true } },
				additionalProperties: false,
			})
		).toBeNull();
		expect(
			compileCanonicalJsonSchema({ type: 'array', items: { type: 'string' }, maxItems: -1 })
		).toBeNull();
		expect(compileCanonicalJsonSchema({ type: 'string', pattern: '(' })).toBeNull();
		expect(compileCanonicalJsonSchema({ type: 'string', pattern: '(a+)+$' })).toBeNull();

		const validator = compileCanonicalJsonSchema({ type: 'object' });
		expect(validator?.validate({ deeply: { nested: { value: true } } }, { maxDepth: 2 })).toBe(
			false
		);
		expect(validator?.validate({ one: 1, two: 2 }, { maxNodes: 2 })).toBe(false);
		expect(validator?.validate({ value: 'four' }, { maxBytes: 10 })).toBe(false);
	});
});
