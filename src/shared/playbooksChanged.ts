/**
 * The push main sends after any write to an agent's playbook records: create,
 * update, delete, delete-all, ZIP import, and marketplace import. Its one
 * argument is the agent (session) id whose list changed, so a surface showing
 * another agent's playbooks can ignore it.
 *
 * Surfaces that list playbooks (the Auto Run panel's playbook dropdown) reload
 * on it instead of reading the list once at mount, so a record written by
 * another surface (the Playbook Exchange, the CLI's bridge) shows up live.
 */
export const PLAYBOOKS_CHANGED_CHANNEL = 'playbooks:changed';
