/** Transient host process evidence. Never persisted as conversation origin or tab state. */
export interface HeadlessAgentActivity {
	revision: number;
	/** Target agent id -> number of provider processes still owned by the host. */
	counts: Record<string, number>;
}
