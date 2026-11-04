import type { startTurn } from '../../shared/maestro-lib/run/start-turn';
import { CodexAppServerRpc } from '../codex-app-server/rpc-client';
import { isCodexResponse } from '../codex-app-server/protocol';
import { planSpawnShell } from '../process-manager/utils/windowsSpawnShell';
import { withWorktreeTurnActivity } from '../git/worktreeTurnActivity';
import { captureException } from '../utils/sentry';

/** Skills reported by Codex itself, including enabled plugins and system skills.
 * This only reads metadata: no thread or model turn is started.
 */
export async function discoverCodexSkills(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv
): Promise<Array<{ name: string; description?: string; prompt: string }>> {
	// Discovery owns a native child outside ProcessManager. Keep its close and
	// the full protocol/cleanup operation independent, including failed starts.
	return withWorktreeTurnActivity(
		(start, observe) => observe(discoverCodexSkillsAdmitted(command, cwd, env, start, observe)),
		(error) => void captureException(error)
	);
}

async function discoverCodexSkillsAdmitted(
	command: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	start: typeof startTurn,
	observe: <T>(completion: Promise<T>) => Promise<T>
) {
	const rpc = new CodexAppServerRpc((line) => {
		if (!turn.child.stdin?.writable) throw new Error('Codex stdin is closed');
		turn.child.stdin.write(`${line}\n`);
	});
	const shellPlan = planSpawnShell(command, ['app-server'], {});
	const turn = start(
		{ ...shellPlan, cwd, env },
		{
			onLine: (line) => {
				withWorktreeTurnActivity(
					() => {
						try {
							const message = JSON.parse(line);
							if (isCodexResponse(message)) rpc.handleResponse(message);
						} catch {
							// Older CLIs may print diagnostic lines alongside JSON.
						}
					},
					(error) => void captureException(error)
				);
			},
			onStdinError: (error) =>
				withWorktreeTurnActivity(
					() => rpc.close(error.message),
					(error) => void captureException(error)
				),
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
	observe(
		turn.done.then(() =>
			withWorktreeTurnActivity(
				() => rpc.close('Codex skill discovery exited'),
				(error) => void captureException(error)
			)
		)
	);
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
