// A yes/no question on the terminal, for the few CLI verbs whose write cannot
// be undone from the CLI.
//
// It asks only when both ends are a terminal. A script has no one to answer, so
// it must pass the verb's `--yes` instead: asking a closed stdin would either
// hang or read "no" for a decision nobody made.

import * as readline from 'readline';

/** Whether a person can be asked (stdin and stdout are both a terminal). */
export function canPrompt(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** Ask `question` and resolve `true` for `y` or `yes`. The default is no. */
export function confirmOnTerminal(question: string): Promise<boolean> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(`${question} [y/N] `, (answer) => {
			rl.close();
			resolve(/^y(es)?$/i.test(answer.trim()));
		});
	});
}
