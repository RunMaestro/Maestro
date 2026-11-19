import { describe, it, expect } from 'vitest';
import { describeMarketplaceImportFailures } from '../../shared/marketplace-types';

describe('describeMarketplaceImportFailures', () => {
	it('returns null when nothing failed or the lists are absent', () => {
		expect(describeMarketplaceImportFailures({ failedDocs: [], failedAssets: [] })).toBeNull();
		expect(describeMarketplaceImportFailures({})).toBeNull();
	});

	it('names failed documents and assets, singular and plural', () => {
		expect(describeMarketplaceImportFailures({ failedDocs: ['Agent-Prompt'] })).toBe(
			'Not imported: document Agent-Prompt'
		);
		expect(
			describeMarketplaceImportFailures({
				failedDocs: ['phase-1', 'phase-2'],
				failedAssets: ['scanner.py'],
			})
		).toBe('Not imported: documents phase-1, phase-2; asset scanner.py');
		expect(describeMarketplaceImportFailures({ failedAssets: ['a.py', 'b.yaml'] })).toBe(
			'Not imported: assets a.py, b.yaml'
		);
	});
});
