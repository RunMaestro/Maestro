import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { canonicalJson } from '../../../shared/canonicalJson';

const fixture = createBoardIsolationFixture();
beforeAll(() => fixture.install());
afterAll(() => fixture.cleanup());

it('fails closed when the writer changes a source during the authorized append', async () => {
	const { contract, sources } = fixture;
	const host = await import('../../../main/board/board-source-host');
	const agent = {
		id: randomUUID(),
		name: 'Owned agent',
		toolType: 'codex',
		cwd: sources.one,
		projectRoot: sources.one,
		fullPath: sources.one,
	};
	const append = host.configureIsolatedBoardSourceHost(contract, {
		identity: contract.identity,
		name: agent.name,
		toolType: agent.toolType,
		cwd: agent.cwd,
	})!;
	const writer = vi.fn(() => {
		fs.writeFileSync(contract.agentRegistry, canonicalJson({ sessions: [agent] }));
		fs.writeFileSync(contract.sourceRegistry, canonicalJson({ sources: [] }));
	});
	expect(() => append(agent, writer)).toThrow('changed unrelated registrations');
	// Even restoring source bytes cannot revive the consumed append capability
	// or admit the unexpected new registry through ordinary host operations.
	fs.writeFileSync(
		contract.sourceRegistry,
		canonicalJson({
			sources: [
				{ id: 'one', root: sources.one },
				{ id: 'two', root: sources.two },
			],
		})
	);
	expect(() => host.refreshBoardSources()).toThrow('was not admitted');
	expect(() => append(agent, writer)).toThrow();
	expect(() => host.configureIsolatedBoardSourceHost(contract)).toThrow();
	expect(writer).toHaveBeenCalledTimes(1);
});
