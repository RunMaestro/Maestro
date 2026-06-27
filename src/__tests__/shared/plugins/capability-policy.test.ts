import { describe, it, expect } from 'vitest';
import { transcriptReadEgressConflict } from '../../../shared/plugins/capability-policy';
import type { PluginCapability } from '../../../shared/plugins/permissions';

const hold = (...caps: PluginCapability[]) => caps.map((capability) => ({ capability }));

describe('transcriptReadEgressConflict', () => {
	it('allows the combination for a TRUSTED plugin', () => {
		expect(
			transcriptReadEgressConflict(hold('transcripts:read', 'net:fetch'), { trusted: true })
		).toBeNull();
		expect(
			transcriptReadEgressConflict(hold('transcripts:read', 'process:spawn'), { trusted: true })
		).toBeNull();
	});

	it('blocks transcripts:read + net:fetch for an untrusted plugin', () => {
		const reason = transcriptReadEgressConflict(hold('transcripts:read', 'net:fetch'), {
			trusted: false,
		});
		expect(reason).toMatch(/net:fetch/);
		expect(reason).toMatch(/transcripts:read/);
	});

	it('blocks transcripts:read + process:spawn for an untrusted plugin', () => {
		expect(
			transcriptReadEgressConflict(hold('transcripts:read', 'process:spawn'), { trusted: false })
		).toMatch(/process:spawn/);
	});

	it('allows transcripts:read alone, or egress alone, for an untrusted plugin', () => {
		expect(transcriptReadEgressConflict(hold('transcripts:read'), { trusted: false })).toBeNull();
		expect(
			transcriptReadEgressConflict(hold('net:fetch', 'fs:read'), { trusted: false })
		).toBeNull();
		expect(transcriptReadEgressConflict(hold('process:spawn'), { trusted: false })).toBeNull();
	});

	it('reports the first egress capability when several are present', () => {
		const reason = transcriptReadEgressConflict(
			hold('transcripts:read', 'net:fetch', 'process:spawn'),
			{ trusted: false }
		);
		expect(reason).toMatch(/net:fetch/);
	});
});
