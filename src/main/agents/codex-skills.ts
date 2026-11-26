import * as os from 'os';
import type { SshRemoteConfig } from '../../shared/types';
import { startTurn } from '../../shared/maestro-lib/run/start-turn';
import { agentEnvOverRemote, buildSshCommand } from '../utils/ssh-command-builder';
import { CodexAppServerRpc } from '../codex-app-server/rpc-client';
import { isCodexResponse } from '../codex-app-server/protocol';
import { planSpawnShell } from '../process-manager/utils/windowsSpawnShell';

/** Where Codex runs for an SSH agent: the remote, and the env to set there. */
export interface CodexSkillsRemote {
	config: SshRemoteConfig;
	/** Set on the remote before `codex app-server` starts (the agent's own vars). */
	env?: Record<string, string>;
}

/** Skills reported by Codex itself, including enabled plugins and system skills.
 * This only reads metadata: no thread or model turn is started.
 *
 * Codex runs where the agent runs: on this machine, or, with `remote`, on the
 * SSH remote in the agent's folder there (`command` is then the binary on the
 * remote, and `env` is this machine's env for the ssh client). The RPC is the
 * same either way: ssh carries the JSON lines.
 */
export async function discoverCodexSkills(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	remote?: CodexSkillsRemote
): Promise<Array<{ name: string; description?: string; prompt: string }>> {
	const rpc = new CodexAppServerRpc((line) => {
		if (!turn.child.stdin?.writable) throw new Error('Codex stdin is closed');
		turn.child.stdin.write(`${line}\n`);
	});
	// A blank agent value cancels the remote's layer, then is dropped.
	const target = remote ? agentEnvOverRemote(remote.config, remote.env) : null;
	const launch = target
		? await buildSshCommand(target.config, {
				command,
				args: ['app-server'],
				cwd,
				env: target.env,
				useStdin: true,
			}).then((ssh) => ({
				...planSpawnShell(ssh.command, ssh.args, {}),
				cwd: os.homedir(),
			}))
		: { ...planSpawnShell(command, ['app-server'], {}), cwd };
	const turn = startTurn(
		{ ...launch, env },
		{
			onLine: (line) => {
				try {
					const message = JSON.parse(line);
					if (isCodexResponse(message)) rpc.handleResponse(message);
				} catch {
					// Older CLIs may print diagnostic lines alongside JSON.
				}
			},
			onStdinError: (error) => rpc.close(error.message),
		},
		{
			keepStdinOpen: true,
			stopGraceMs: 250,
			stdoutTailLimit: 0,
			stderrTailLimit: 0,
			maxLineLength: 4 * 1024 * 1024,
			label: 'codex-skill-discovery',
		}
	);
	void turn.done.then(() => rpc.close('Codex skill discovery exited'));
	try {
		await rpc.request(
			'initialize',
			{
				clientInfo: { name: 'maestro', version: '1.0.0' },
			},
			{ timeoutMs: 5000 }
		);
		rpc.notify('initialized');
		const result = await rpc.request<{
			data: Array<{
				cwd: string;
				skills: Array<{
					name: string;
					description?: string;
					path: string;
					enabled: boolean;
					interface?: { shortDescription?: string } | null;
				}>;
			}>;
		}>('skills/list', { cwds: [cwd], forceReload: true }, { timeoutMs: 5000 });
		const commands = new Map<string, { name: string; description?: string; prompt: string }>();
		for (const entry of result.data) {
			if (entry.cwd !== cwd) continue;
			for (const skill of entry.skills) {
				if (!skill.enabled || !skill.name || !skill.path || commands.has(skill.name)) continue;
				commands.set(skill.name, {
					name: skill.name,
					description: skill.interface?.shortDescription || skill.description,
					// Preserve native skill loading and the location of relative resources.
					prompt: `$${skill.name}\n\nUse the skill at ${JSON.stringify(skill.path)}.`,
				});
			}
		}
		return [...commands.values()];
	} finally {
		rpc.close('Codex skill discovery finished');
		turn.terminate();
		await turn.done;
	}
}
