import { describe, expect, it } from 'vitest';
import {
	buildDocumentList,
	generateDefaultFolderName,
	getCategoryCount,
	getCycledDocumentFilename,
	partitionPlaybooksByCompatibility,
} from '../../../../../renderer/components/MarketplaceModal/helpers';
import { makePlaybook } from '../_fixtures';

describe('MarketplaceModal helpers', () => {
	it('partitions compatible playbooks before incompatible playbooks while preserving group order', () => {
		const compatibleA = makePlaybook({ id: 'a', title: 'A' });
		const incompatible = makePlaybook({
			id: 'b',
			title: 'B',
			minMaestroVersion: '99.0.0',
		});
		const compatibleC = makePlaybook({ id: 'c', title: 'C' });

		const result = partitionPlaybooksByCompatibility(
			[compatibleA, incompatible, compatibleC],
			'1.0.0'
		);

		expect(result.compatiblePlaybooks.map((playbook) => playbook.id)).toEqual(['a', 'c']);
		expect(result.incompatiblePlaybooks.map((playbook) => playbook.id)).toEqual(['b']);
		expect(result.orderedPlaybooks.map((playbook) => playbook.id)).toEqual(['a', 'c', 'b']);
	});

	it('counts all playbooks and category-specific playbooks', () => {
		const playbooks = [
			makePlaybook({ id: 'a', category: 'Development' }),
			makePlaybook({ id: 'b', category: 'Security' }),
			makePlaybook({ id: 'c', category: 'Development' }),
		];

		expect(getCategoryCount('All', playbooks)).toBe(3);
		expect(getCategoryCount('Development', playbooks)).toBe(2);
		expect(getCategoryCount('Security', playbooks)).toBe(1);
		expect(getCategoryCount('Missing', playbooks)).toBe(0);
	});

	it('generates a single-segment folder slug from a title', () => {
		expect(generateDefaultFolderName('My Great Playbook')).toBe('my-great-playbook');
		expect(generateDefaultFolderName('  API/API: Review!! ')).toBe('api-api-review');
		expect(generateDefaultFolderName('Already---Slugged')).toBe('already-slugged');
	});

	it('builds the README-first document list', () => {
		expect(buildDocumentList(makePlaybook())).toEqual([null, 'phase-1', 'phase-2']);
	});

	it('cycles documents forward and backward with README wraparound', () => {
		const playbook = makePlaybook();

		expect(getCycledDocumentFilename(playbook, null, 'next')).toBe('phase-1');
		expect(getCycledDocumentFilename(playbook, 'phase-1', 'next')).toBe('phase-2');
		expect(getCycledDocumentFilename(playbook, 'phase-2', 'next')).toBe('');
		expect(getCycledDocumentFilename(playbook, null, 'previous')).toBe('phase-2');
		expect(getCycledDocumentFilename(playbook, 'phase-1', 'previous')).toBe('');
	});

	it('preserves the original unknown-document cycling behavior', () => {
		const playbook = makePlaybook();

		expect(getCycledDocumentFilename(playbook, 'missing', 'next')).toBe('');
		expect(getCycledDocumentFilename(playbook, 'missing', 'previous')).toBe('phase-2');
	});
});
