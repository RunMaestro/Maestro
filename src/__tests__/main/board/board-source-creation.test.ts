import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';
import { canonicalJson } from '../../../shared/canonicalJson';

const fixture = createBoardIsolationFixture();
beforeAll(() => fixture.install());
afterAll(() => fixture.cleanup());

it('allows one parent-bound append and refuses identity, path, request, source and competing registry changes', async () => {
	const { contract, sources } = fixture;
	const host = await import('../../../main/board/board-source-host');
	const admission = await import('../../../main/board/board-isolation');
	const before = fs.readFileSync(contract.agentRegistry);
	const sourceBefore = fs.readFileSync(contract.sourceRegistry);
	const request = {
		identity: contract.identity,
		name: 'Owned agent',
		toolType: 'codex',
		cwd: sources.one,
	};
	const append = host.configureIsolatedBoardSourceHost(contract, request)!;
	const agent = {
		id: randomUUID(),
		name: request.name,
		toolType: request.toolType,
		cwd: sources.one,
		projectRoot: sources.one,
		fullPath: sources.one,
	};
	const write = vi.fn(() =>
		fs.writeFileSync(contract.agentRegistry, canonicalJson({ sessions: [agent] }))
	);
	for (const patch of [
		{ id: 'fixture-agent' },
		{ name: 'Different request' },
		{ toolType: 'claude-code' },
		{ cwd: sources.two },
		{ projectRoot: contract.worktree },
		{ fullPath: sources.two },
		{ sshRemoteId: 'other-host' },
		{ sessionSshRemoteConfig: { enabled: true } },
	]) {
		expect(() => append({ ...agent, ...patch }, write)).toThrow();
		expect(fs.readFileSync(contract.agentRegistry)).toEqual(before);
	}
	vi.stubEnv('BOARD_ISOLATION_ID', 'wrong-owner');
	expect(() => append(agent, write)).toThrow();
	vi.unstubAllEnvs();
	fs.writeFileSync(
		contract.agentRegistry,
		canonicalJson({ sessions: [{ ...agent, id: randomUUID() }] })
	);
	expect(() => append(agent, write)).toThrow();
	fs.writeFileSync(contract.agentRegistry, before);
	fs.writeFileSync(
		contract.sourceRegistry,
		canonicalJson({ sources: [{ id: 'other', root: sources.two }] })
	);
	expect(() => append(agent, write)).toThrow();
	fs.writeFileSync(contract.sourceRegistry, sourceBefore);
	expect(write).not.toHaveBeenCalled();
	// Mutating the caller's request cannot widen the retained capability.
	request.name = 'Changed after authorization';
	append(agent, write);
	expect(write).toHaveBeenCalledTimes(1);
	expect(admission.readBoardIsolationRegistries(contract).sessions).toEqual([agent]);
	expect(fs.readFileSync(contract.sourceRegistry)).toEqual(sourceBefore);
	expect(() => append(agent, write)).toThrow();
	expect(() => append({ ...agent, id: randomUUID() }, write)).toThrow();
	expect(() => host.configureIsolatedBoardSourceHost(contract)).toThrow();
	expect(write).toHaveBeenCalledTimes(1);
});
