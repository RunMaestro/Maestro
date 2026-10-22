import {
	getAtMentionTrigger,
	type AtMentionTriggerResult,
} from '../../../../shared/maestro-lib/mentions/trigger';

// The `@` trigger rules moved to maestro-lib so the TUI composer reads the same ones.
export { getAtMentionTrigger };
export type { AtMentionTriggerResult };

export function shouldOpenSlashCommand(value: string): boolean {
	return value.startsWith('/') && !value.includes(' ') && !value.includes('\n');
}
