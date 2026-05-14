import { describe, it, expect } from 'vitest';
import {
	composeCueSubscriptionId,
	parseCueSubscriptionId,
	pipelineKeyForSubscription,
} from '../../../shared/cue/subscription-id';

describe('cue/subscription-id', () => {
	describe('pipelineKeyForSubscription', () => {
		it('prefers explicit pipeline_name', () => {
			expect(
				pipelineKeyForSubscription({ name: 'Pipe-chain-1', pipeline_name: 'My Pipeline' })
			).toBe('My Pipeline');
		});

		it('strips -chain-N suffix when pipeline_name is absent', () => {
			expect(pipelineKeyForSubscription({ name: 'Build-chain-3' })).toBe('Build');
		});

		it('strips -fanin suffix when pipeline_name is absent', () => {
			expect(pipelineKeyForSubscription({ name: 'Aggregate-fanin' })).toBe('Aggregate');
		});

		it('strips -cmd-<id> suffix when pipeline_name is absent', () => {
			expect(pipelineKeyForSubscription({ name: 'Run-cmd-abc123' })).toBe('Run');
		});

		it('strips -cli-out suffix when pipeline_name is absent', () => {
			expect(pipelineKeyForSubscription({ name: 'Deploy-cli-out' })).toBe('Deploy');
		});

		it('returns the original name when no suffix matches', () => {
			expect(pipelineKeyForSubscription({ name: 'Standalone' })).toBe('Standalone');
		});

		it('ignores an empty pipeline_name', () => {
			expect(pipelineKeyForSubscription({ name: 'Build-chain-1', pipeline_name: '' })).toBe(
				'Build'
			);
		});
	});

	describe('composeCueSubscriptionId', () => {
		it('emits sessionId::pipeline::name', () => {
			expect(
				composeCueSubscriptionId('sess-1', {
					name: 'Digest Script',
					pipeline_name: 'Obsidian Daily Pipe',
				})
			).toBe('sess-1::Obsidian Daily Pipe::Digest Script');
		});

		it('disambiguates two same-named subs in different pipelines under one session', () => {
			const a = composeCueSubscriptionId('sess-1', { name: 'Foo', pipeline_name: 'A' });
			const b = composeCueSubscriptionId('sess-1', { name: 'Foo', pipeline_name: 'B' });
			expect(a).not.toBe(b);
		});

		it('falls back to base-name stripping when pipeline_name is absent', () => {
			expect(composeCueSubscriptionId('sess-1', { name: 'Build-chain-1' })).toBe(
				'sess-1::Build::Build-chain-1'
			);
		});

		it('throws when any component contains the "::" separator', () => {
			// Hand-edited YAML could in principle smuggle "::" into a name;
			// surface that loudly rather than silently emitting an
			// unparseable id that the toggle path would reject as "no such
			// subscription".
			expect(() =>
				composeCueSubscriptionId('sess::1', { name: 'Foo', pipeline_name: 'A' })
			).toThrow(/must not contain/);
			expect(() =>
				composeCueSubscriptionId('sess-1', { name: 'Foo', pipeline_name: 'A::B' })
			).toThrow(/must not contain/);
			expect(() =>
				composeCueSubscriptionId('sess-1', { name: 'Foo::Bar', pipeline_name: 'A' })
			).toThrow(/must not contain/);
		});
	});

	describe('parseCueSubscriptionId', () => {
		it('round-trips a composed id', () => {
			const id = composeCueSubscriptionId('sess-1', {
				name: 'Digest Script',
				pipeline_name: 'Obsidian Daily Pipe',
			});
			expect(parseCueSubscriptionId(id)).toEqual({
				sessionId: 'sess-1',
				pipeline: 'Obsidian Daily Pipe',
				name: 'Digest Script',
			});
		});

		it('returns null when the id does not have exactly three components', () => {
			expect(parseCueSubscriptionId('only-one-part')).toBeNull();
			expect(parseCueSubscriptionId('two::parts')).toBeNull();
			expect(parseCueSubscriptionId('four::part::id::here')).toBeNull();
		});

		it('returns null when any component is empty', () => {
			expect(parseCueSubscriptionId('::pipeline::name')).toBeNull();
			expect(parseCueSubscriptionId('sess::::name')).toBeNull();
			expect(parseCueSubscriptionId('sess::pipeline::')).toBeNull();
		});
	});
});
