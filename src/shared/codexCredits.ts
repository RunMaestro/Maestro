/**
 * Additional ChatGPT/Codex usage credits, reported by the account's quota endpoint.
 * These are separate from rate-limit reset credits and OpenAI API funds.
 * An absent credits value means the server did not provide usable credit details.
 */
export type CodexCreditBalance = { kind: 'balance'; balance: number } | { kind: 'unlimited' };
