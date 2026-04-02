# Maestro × OpenClaw 統合 Blueprint

**Version**: 1.0.0
**Date**: 2026-04-02
**Status**: Ready for Implementation

---

## 概要

OpenClaw (Miyabi Agent Orchestration Platform) を Maestro のネイティブエージェントとして統合する。
本ドキュメントは、Maestro のソースコード（v0.15.3）を実際に精査し、
既存エージェント（claude-code, codex, opencode, factory-droid）の統合パターンと完全に一致する
**開発AIにそのまま渡せるレベルの実装仕様書**である。

---

## 前提条件

### OpenClaw CLI インターフェース（実機確認済み）

```bash
# OpenClaw v2026.3.13
# サブコマンド: agent（run ではない）
# JSON出力: --json
# セッション指定: --session-id <id>
# メッセージ入力: --message <text> / -m <text>
# エージェント指定: --agent <id>
# ローカル実行: --local
# thinking制御: --thinking <level>

# バッチ実行
openclaw agent --agent <id> --message "<prompt>" --json

# セッションレジューム
openclaw agent --session-id <sessionId> --message "<prompt>" --json

# ローカル実行（Gateway不要）
openclaw agent --agent <id> --message "<prompt>" --json --local
```

### ⚠️ 重要な修正事項（ユーザー初期Blueprintとの差分）

| 項目             | 初期Blueprint（不正確）         | 実際のCLI（正確）                          |
| ---------------- | ------------------------------- | ------------------------------------------ |
| サブコマンド     | `run`                           | `agent`                                    |
| JSON出力フラグ   | `--format json`                 | `--json`                                   |
| セッション指定   | `--session <id>`                | `--session-id <id>`                        |
| プロンプト渡し方 | 位置引数 `"<prompt>"`           | `--message "<prompt>"` / `-m "<prompt>"`   |
| バイナリ名       | `openclaw`                      | `openclaw`（正確）                         |
| 出力形式         | JSONL（1行1イベントストリーム） | **単一JSONオブジェクト**（バッチ結果のみ） |

### 実際の `--json` 出力フォーマット（実機確認済み）

```json
{
	"payloads": [{ "text": "応答テキスト", "mediaUrl": null }],
	"meta": {
		"durationMs": 127310,
		"agentMeta": {
			"sessionId": "e491f1ca-c469-4e23-9144-5068d30f55f3",
			"provider": "anthropic",
			"model": "claude-sonnet-4-6",
			"usage": {
				"input": 3,
				"output": 5,
				"cacheWrite": 212694,
				"total": 212702
			},
			"lastCallUsage": {
				"input": 3,
				"output": 5,
				"cacheRead": 0,
				"cacheWrite": 212694
			}
		}
	}
}
```

**⚠️ 重要**: OpenClaw の `--json` 出力は JSONL ストリームではなく、
プロセス完了時に単一の JSON オブジェクトを出力する。
そのため `usesJsonLineOutput: false`、`supportsStreaming: false` とする。
stderr にはデバッグログが ANSI カラー付きで出力される（パース対象外）。

---

## CI 自動検証

`src/__tests__/main/agents/agent-completeness.test.ts` が以下を検証する：

- `AGENT_IDS` ↔ `AGENT_DEFINITIONS` の双方向整合性
- 各エージェントに `AGENT_CAPABILITIES` の23フィールドが定義されていること
- `supportsJsonOutput: true` なら Output Parser が登録されていること
- `supportsSessionStorage: true` なら Session Storage が登録されていること
- Output Parser があるなら Error Patterns が登録されていること
- `AGENT_CAPABILITIES` に孤立エントリがないこと

**→ 全ステップ完了後に `npm run test` でCI検証をパスすること**

---

## Phase 1: エージェントID登録（型の源泉）

### Step 1: `src/shared/agentIds.ts`

AGENT_IDS タプルに `'openclaw'` を追加する。
これが全ての型（`AgentId`, `ToolType`）の Single Source of Truth。

```typescript
// Line 16-25: AGENT_IDS tuple
export const AGENT_IDS = [
	'terminal',
	'claude-code',
	'codex',
	'gemini-cli',
	'qwen3-coder',
	'opencode',
	'factory-droid',
	'aider',
	'openclaw', // ← 追加
] as const;
```

**効果**: `AgentId` ユニオン型に `'openclaw'` が自動的に含まれ、TypeScript が全依存コードで補完・エラーチェックを強制する。

---

## Phase 2: メタデータ登録

### Step 2: `src/shared/agentMetadata.ts`

#### 2a: 表示名の追加（Line 15-24）

```typescript
export const AGENT_DISPLAY_NAMES: Record<AgentId, string> = {
	terminal: 'Terminal',
	'claude-code': 'Claude Code',
	codex: 'Codex',
	'gemini-cli': 'Gemini CLI',
	'qwen3-coder': 'Qwen3 Coder',
	opencode: 'OpenCode',
	'factory-droid': 'Factory Droid',
	aider: 'Aider',
	openclaw: 'OpenClaw', // ← 追加
};
```

**注**: `Record<AgentId, string>` の型により、追加しないとコンパイルエラーになる。

#### 2b: Beta ステータスの追加（Line 41-45）

```typescript
export const BETA_AGENTS: ReadonlySet<AgentId> = new Set<AgentId>([
	'codex',
	'opencode',
	'factory-droid',
	'openclaw', // ← 追加（初期統合はBeta扱い）
]);
```

### Step 3: `src/shared/agentConstants.ts`

#### 3a: デフォルトコンテキストウィンドウ（Line 16-22）

```typescript
export const DEFAULT_CONTEXT_WINDOWS: Partial<Record<AgentId, number>> = {
	'claude-code': 200000,
	codex: 200000,
	opencode: 128000,
	'factory-droid': 200000,
	terminal: 0,
	openclaw: 200000, // ← 追加（OpenClawのデフォルトモデルに合わせて調整）
};
```

---

## Phase 3: エージェント定義（CLI構成）

### Step 4: `src/main/agents/definitions.ts`

`AGENT_DEFINITIONS` 配列に追加（Line 395 の `aider` 定義の後）。

```typescript
{
	id: 'openclaw',
	name: 'OpenClaw',
	binaryName: 'openclaw',
	command: 'openclaw',
	args: [],                              // Base args（なし）

	// Batch mode: openclaw agent --json --message "prompt"
	batchModePrefix: ['agent'],            // サブコマンド 'agent'
	batchModeArgs: [],                     // 追加のバッチ専用args（なし）

	// JSON出力
	jsonOutputArgs: ['--json'],            // --json フラグ

	// セッションレジューム: --session-id <id>
	resumeArgs: (sessionId: string) => ['--session-id', sessionId],

	// Read-only mode（OpenClawには現状なし）
	readOnlyArgs: [],
	readOnlyCliEnforced: false,            // プロンプトベースのread-only制御

	// プロンプト渡し: --message で渡す（位置引数ではない）
	promptArgs: (prompt: string) => ['--message', prompt],
	noPromptSeparator: true,               // '--' セパレータ不要

	// モデル選択（OpenClawはthinkingレベルで制御）
	// modelArgs は未定義（モデルはOpenClaw側の設定で決まる）

	// デフォルト環境変数
	defaultEnvVars: {},

	// UI設定オプション
	configOptions: [
		{
			key: 'agentId',
			type: 'text',
			label: 'Agent ID',
			description:
				'OpenClaw agent to use (e.g., "main", "ops"). Leave empty for default routing.',
			default: '',
			argBuilder: (value: string) => {
				if (value && value.trim()) {
					return ['--agent', value.trim()];
				}
				return [];
			},
		},
		{
			key: 'thinking',
			type: 'select',
			label: 'Thinking Level',
			description: 'How much the agent should reason before responding.',
			options: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
			default: '',
			argBuilder: (value: string) =>
				value && value.trim() ? ['--thinking', value.trim()] : [],
		},
		{
			key: 'contextWindow',
			type: 'number',
			label: 'Context Window Size',
			description:
				'Maximum context window size in tokens (for UI display). Depends on the underlying model.',
			default: 200000,
		},
		{
			key: 'localMode',
			type: 'checkbox',
			label: 'Local Mode',
			description:
				'Run the embedded agent locally instead of via Gateway (requires model provider API keys).',
			default: false,
			argBuilder: (value: boolean) => (value ? ['--local'] : []),
		},
	],
},
```

---

## Phase 4: 能力フラグ（Capabilities）

### Step 5: `src/main/agents/capabilities.ts`

`AGENT_CAPABILITIES` レコードに追加（Line 387 の `aider` 定義の後）。

```typescript
/**
 * OpenClaw - Miyabi Agent Orchestration Platform
 * https://github.com/RunMaestro/Maestro (integration context)
 *
 * Initial integration: conservative capabilities.
 * OpenClaw routes to various AI backends (Claude, GPT, Gemini)
 * and provides multi-agent orchestration via Gateway.
 */
openclaw: {
	supportsResume: true,              // --session-id flag
	supportsReadOnlyMode: false,       // No CLI-level read-only mode yet
	supportsJsonOutput: true,          // --json flag → 単一JSON結果オブジェクト
	supportsSessionId: true,           // meta.agentMeta.sessionId in JSON output
	supportsImageInput: false,         // Not supported via CLI currently
	supportsImageInputOnResume: false,  // Not supported
	supportsSlashCommands: false,      // Not applicable
	supportsSessionStorage: false,     // Phase 2 で実装（初期は false）
	supportsCostTracking: false,       // OpenClaw doesn't expose cost per turn yet
	supportsUsageStats: true,          // ✅ meta.agentMeta.usage に input/output/cacheWrite/total あり
	supportsBatchMode: true,           // 'agent' subcommand
	requiresPromptToStart: true,       // Requires --message with prompt
	supportsStreaming: false,          // ⚠️ --json は単一JSON結果（ストリームなし）
	supportsResultMessages: true,      // 最終結果の payloads[].text
	supportsModelSelection: false,     // Model is configured via OpenClaw agent config, not CLI flag
	supportsStreamJsonInput: false,    // Not supported
	supportsThinkingDisplay: false,    // ⚠️ --thinking は内部制御のみ、thinking内容はJSON出力に含まれない
	supportsContextMerge: false,       // Not yet investigated
	supportsContextExport: false,      // Not yet investigated
	supportsWizard: false,             // Not yet integrated
	supportsGroupChatModeration: false, // Not yet verified
	usesJsonLineOutput: false,         // ⚠️ 単一JSONオブジェクト出力（JSONLではない）
	usesCombinedContextWindow: false,  // Depends on underlying model provider
},
```

---

## Phase 5: Output Parser（JSON → ParsedEvent 変換）

### Step 6: `src/main/parsers/openclaw-output-parser.ts`（新規作成）

OpenClaw の `--json` 出力をパースして、Maestro の `ParsedEvent` に正規化する。

**✅ 実機確認済み**: OpenClaw `--json` の出力は JSONL ストリームではなく、
プロセス完了時に単一の JSON オブジェクトを stdout に出力する。
stderr にはデバッグログが ANSI カラー付きで流れる。

実際の出力構造:

```json
{
	"payloads": [{ "text": "応答テキスト", "mediaUrl": null }],
	"meta": {
		"durationMs": 127310,
		"agentMeta": {
			"sessionId": "e491f1ca-c469-4e23-9144-5068d30f55f3",
			"provider": "anthropic",
			"model": "claude-sonnet-4-6",
			"usage": { "input": 3, "output": 5, "cacheWrite": 212694, "total": 212702 },
			"lastCallUsage": { "input": 3, "output": 5, "cacheRead": 0, "cacheWrite": 212694 }
		}
	}
}
```

```typescript
/**
 * OpenClaw Output Parser
 *
 * Parses OpenClaw's JSON output into Maestro's normalized ParsedEvent format.
 *
 * ⚠️ OpenClaw の --json 出力は JSONL ストリームではなく、プロセス完了時に
 * 単一の JSON オブジェクトを stdout に出力する。stderr にはデバッグログが流れる。
 *
 * 構造:
 * {
 *   payloads: [{ text: string, mediaUrl: string | null }],
 *   meta: {
 *     durationMs: number,
 *     agentMeta: {
 *       sessionId: string,
 *       provider: string,
 *       model: string,
 *       usage: { input, output, cacheWrite, total },
 *       lastCallUsage: { input, output, cacheRead, cacheWrite }
 *     }
 *   }
 * }
 *
 * CLI: openclaw agent --json --agent <id> --message "prompt"
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[OpenClawParser]';

/** OpenClaw の payloads 配列の要素 */
interface OpenClawPayload {
	text: string;
	mediaUrl: string | null;
}

/** OpenClaw の usage 構造 */
interface OpenClawUsage {
	input: number;
	output: number;
	cacheWrite?: number;
	cacheRead?: number;
	total?: number;
}

/** OpenClaw の agentMeta 構造 */
interface OpenClawAgentMeta {
	sessionId: string;
	provider: string;
	model: string;
	usage: OpenClawUsage;
	lastCallUsage?: OpenClawUsage;
}

/** OpenClaw の --json 出力のルート構造 */
interface OpenClawJsonResult {
	payloads: OpenClawPayload[];
	meta: {
		durationMs: number;
		agentMeta: OpenClawAgentMeta;
	};
}

export class OpenClawOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'openclaw';

	/**
	 * OpenClaw は単一 JSON オブジェクトを出力するため、
	 * stdout 全体を1つの JSON として parseJsonLine に渡す。
	 * Maestro の process-manager が stdout を行ごとに分割するので、
	 * JSON が複数行にまたがる場合はバッファリングが必要。
	 *
	 * NOTE: process-manager が最終的に stdout 全体をまとめて
	 * parseJsonLine に渡す場合はそのまま動作する。
	 * 行単位の場合は、JSON.parse が失敗した行は null を返し、
	 * 完全な JSON が来た時点でパースされる。
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		// stderr のデバッグログ（ANSI エスケープ付き）をスキップ
		const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
		if (!stripped || stripped.startsWith('[')) {
			// OpenClaw stderr format: [33m[agent/embedded][39m ...
			return null;
		}

		try {
			const parsed = JSON.parse(stripped);
			return this.parseJsonObject(parsed);
		} catch {
			// 不完全な JSON 行 — スキップ
			return null;
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const msg = parsed as Record<string, unknown>;

		// ── OpenClaw の標準 --json 出力を検出 ──
		// { payloads: [...], meta: { ... } }
		if (Array.isArray(msg.payloads) && msg.meta) {
			return this.parseOpenClawResult(msg as unknown as OpenClawJsonResult);
		}

		// ── フォールバック: 将来の JSONL ストリーミング対応用 ──
		const eventType = (msg.type as string) || '';

		if (eventType === 'error') {
			return {
				type: 'error',
				text: (msg.message as string) || (msg.error as string) || 'Unknown OpenClaw error',
				raw: msg,
			};
		}

		// 不明な構造
		logger.debug(`${LOG_CONTEXT} Unrecognized JSON structure`, LOG_CONTEXT, {
			keys: Object.keys(msg),
		});
		return null;
	}

	/**
	 * OpenClaw の完了時 JSON レスポンスを ParsedEvent に変換
	 */
	private parseOpenClawResult(result: OpenClawJsonResult): ParsedEvent {
		const agentMeta = result.meta?.agentMeta;

		// payloads のテキストを結合（通常は1要素）
		const text = result.payloads
			.map((p) => p.text)
			.filter(Boolean)
			.join('\n');

		// usage の抽出
		let usage: ParsedEvent['usage'] | undefined;
		if (agentMeta?.usage) {
			const u = agentMeta.usage;
			usage = {
				inputTokens: u.input || 0,
				outputTokens: u.output || 0,
				cacheCreationTokens: u.cacheWrite || undefined,
				cacheReadTokens: agentMeta.lastCallUsage?.cacheRead || undefined,
			};
		}

		return {
			type: 'result',
			sessionId: agentMeta?.sessionId || undefined,
			text,
			usage,
			raw: result,
		};
	}

	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId ?? null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage ?? null;
	}

	extractSlashCommands(_event: ParsedEvent): string[] | null {
		// OpenClaw does not support slash commands
		return null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		const patterns = getErrorPatterns('openclaw');
		const match = matchErrorPattern(patterns, line);
		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: 'openclaw',
				timestamp: Date.now(),
			};
		}
		return null;
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') return null;
		const msg = parsed as Record<string, unknown>;

		// Check for error type events
		if (msg.type === 'error') {
			const errorMessage =
				(msg.message as string) || (msg.error as string) || 'Unknown OpenClaw error';

			return {
				type: 'agent_crashed',
				message: errorMessage,
				recoverable: true,
				agentId: 'openclaw',
				timestamp: Date.now(),
			};
		}

		return null;
	}

	detectErrorFromExit(exitCode: number, stderr: string, _stdout: string): AgentError | null {
		if (exitCode === 0) return null;

		// Check stderr for known patterns (strip ANSI codes first)
		if (stderr) {
			const cleanStderr = stderr.replace(/\x1b\[[0-9;]*m/g, '');
			const patterns = getErrorPatterns('openclaw');
			const match = matchErrorPattern(patterns, cleanStderr);
			if (match) {
				return {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: 'openclaw',
					timestamp: Date.now(),
				};
			}
		}

		return {
			type: 'agent_crashed',
			message: `OpenClaw process exited with code ${exitCode}`,
			recoverable: exitCode === 1, // Exit code 1 is often recoverable
			agentId: 'openclaw',
			timestamp: Date.now(),
		};
	}
}
```

### Step 7: `src/main/parsers/index.ts` に登録

```typescript
// Line 56 付近: Import 追加
import { OpenClawOutputParser } from './openclaw-output-parser';

// Line 68 付近: Export 追加
export { OpenClawOutputParser } from './openclaw-output-parser';

// Line 76-89: initializeOutputParsers 内に追加
export function initializeOutputParsers(): void {
	clearParserRegistry();

	registerOutputParser(new ClaudeOutputParser());
	registerOutputParser(new OpenCodeOutputParser());
	registerOutputParser(new CodexOutputParser());
	registerOutputParser(new FactoryDroidOutputParser());
	registerOutputParser(new OpenClawOutputParser()); // ← 追加

	const registeredParsers = getAllOutputParsers().map((p) => p.agentId);
	logger.info(`Initialized output parsers: ${registeredParsers.join(', ')}`, LOG_CONTEXT);
}
```

---

## Phase 6: エラーパターン

### Step 8: `src/main/parsers/error-patterns.ts`

新しいセクションを追加（Factory Droid セクションの後、SSH セクションの前）。

```typescript
// ============================================================================
// OpenClaw Error Patterns
// ============================================================================

const OPENCLAW_ERROR_PATTERNS: AgentErrorPatterns = {
	auth_expired: [
		{
			pattern: /gateway.*auth.*failed|gateway.*token.*invalid/i,
			message: 'Gateway authentication failed. Please check your OpenClaw token.',
			recoverable: true,
		},
		{
			pattern: /unauthorized|not\s+authenticated/i,
			message: 'Not authenticated. Please run "openclaw configure" to set up credentials.',
			recoverable: true,
		},
		{
			pattern: /api.*key.*invalid|invalid.*api.*key/i,
			message: 'Invalid API key on the underlying model provider. Check agent configuration.',
			recoverable: true,
		},
		{
			pattern: /authentication.*error/i,
			message: 'Authentication error. Please verify your OpenClaw configuration.',
			recoverable: true,
		},
	],

	token_exhaustion: [
		{
			pattern: /context.*exceeded|context.*too\s+long/i,
			message: 'Context limit exceeded. Start a new session.',
			recoverable: true,
		},
		{
			pattern: /prompt.*too\s+long/i,
			message: 'Prompt is too long. Try a shorter message or start a new session.',
			recoverable: true,
		},
		{
			pattern: /maximum.*tokens|token.*limit/i,
			message: 'Maximum token limit reached. Start a new session.',
			recoverable: true,
		},
	],

	rate_limited: [
		{
			pattern: /rate.*limit/i,
			message: 'Rate limit exceeded. Please wait before trying again.',
			recoverable: true,
		},
		{
			pattern: /too many requests|\b429\b/i,
			message: 'Too many requests. Please wait before sending more messages.',
			recoverable: true,
		},
		{
			pattern: /quota.*exceeded/i,
			message: 'API quota exceeded. Resume when quota resets.',
			recoverable: true,
		},
		{
			pattern: /cooldown|backoff/i,
			message: 'Agent in cooldown. Please wait before retrying.',
			recoverable: true,
		},
	],

	network_error: [
		{
			pattern: /gateway.*connection.*refused|gateway.*unreachable/i,
			message: 'Cannot connect to OpenClaw Gateway. Ensure the gateway is running.',
			recoverable: true,
		},
		{
			pattern: /connection\s*(failed|refused|error|reset|closed)/i,
			message: 'Connection failed. Check your network connection.',
			recoverable: true,
		},
		{
			pattern: /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i,
			message: 'Network error. Check your connection to the Gateway.',
			recoverable: true,
		},
		{
			pattern: /request\s+timed?\s*out|timed?\s*out\s+waiting/i,
			message: 'Request timed out. The agent may be overloaded.',
			recoverable: true,
		},
		{
			pattern: /wss?:\/\/.*failed|websocket.*error/i,
			message: 'WebSocket connection to Gateway failed. Check Gateway status.',
			recoverable: true,
		},
	],

	permission_denied: [
		{
			pattern: /SYSTEM_RUN_DENIED/i,
			message: 'Execution denied by OpenClaw security policy.',
			recoverable: false,
		},
		{
			pattern: /permission denied|access denied/i,
			message: 'Permission denied. Check OpenClaw exec-approvals configuration.',
			recoverable: false,
		},
	],

	agent_crashed: [
		{
			pattern: /\b(fatal|unexpected|internal|unhandled)\s+error\b/i,
			message: 'An unexpected error occurred in OpenClaw.',
			recoverable: true,
		},
		{
			pattern: /agent.*not\s+found|unknown\s+agent/i,
			message: 'Agent not found. Check the agent ID in configuration.',
			recoverable: true,
		},
		{
			pattern: /node.*offline|worker.*unavailable/i,
			message: 'The assigned worker node is offline. Check cluster status.',
			recoverable: true,
		},
	],

	session_not_found: [
		{
			pattern: /session.*not\s+found/i,
			message: 'Session not found. Starting fresh conversation.',
			recoverable: true,
		},
		{
			pattern: /invalid.*session/i,
			message: 'Invalid session. Starting fresh conversation.',
			recoverable: true,
		},
		{
			pattern: /pass\s+--to.*--session-id.*--agent/i,
			message: 'Session routing error. Please specify an agent or session.',
			recoverable: true,
		},
	],
};
```

#### パターンレジストリへの登録（Line 862-867 付近）

```typescript
const patternRegistry = new Map<ToolType, AgentErrorPatterns>([
	['claude-code', CLAUDE_ERROR_PATTERNS],
	['opencode', OPENCODE_ERROR_PATTERNS],
	['codex', CODEX_ERROR_PATTERNS],
	['factory-droid', FACTORY_DROID_ERROR_PATTERNS],
	['openclaw', OPENCLAW_ERROR_PATTERNS], // ← 追加
]);
```

---

## Phase 7: Renderer 型同期（必須）

### Step 9: `src/renderer/hooks/agent/useAgentCapabilities.ts`

このファイル内の `AgentCapabilities` インターフェースが `src/main/agents/capabilities.ts` と**完全同期**していることを確認する。

新しいフィールドを追加していないため、**型変更は不要**。ただし、以下を確認：

1. `AgentCapabilities` インターフェースの23フィールドが main 側と一致
2. `DEFAULT_CAPABILITIES` のデフォルト値が main 側と一致

### Step 10: `src/renderer/types/index.ts` と `src/renderer/global.d.ts`

同様に型の同期を確認。新規フィールド追加がないため変更不要だが、
`ToolType` が `AgentId` から派生していることを確認。

---

## Phase 8: Session Storage（Phase 2 実装 — 初期は SKIP）

### Step 11:（将来実装）`src/main/storage/openclaw-session-storage.ts`

初期統合では `supportsSessionStorage: false` のため、このステップはスキップ。

将来実装する場合：

- OpenClaw のセッションファイルの保存場所を特定（`~/.openclaw/` 配下を調査）
- `BaseSessionStorage` を継承して実装
- `src/main/storage/index.ts` に登録

---

## 実装ファイル一覧（チェックリスト）

| #   | ファイル                                           | 操作                                    | Phase |
| --- | -------------------------------------------------- | --------------------------------------- | ----- |
| 1   | `src/shared/agentIds.ts`                           | 編集: AGENT_IDS に `'openclaw'` 追加    | 1     |
| 2   | `src/shared/agentMetadata.ts`                      | 編集: AGENT_DISPLAY_NAMES + BETA_AGENTS | 2     |
| 3   | `src/shared/agentConstants.ts`                     | 編集: DEFAULT_CONTEXT_WINDOWS           | 2     |
| 4   | `src/main/agents/definitions.ts`                   | 編集: AGENT_DEFINITIONS 配列に追加      | 3     |
| 5   | `src/main/agents/capabilities.ts`                  | 編集: AGENT_CAPABILITIES レコードに追加 | 4     |
| 6   | `src/main/parsers/openclaw-output-parser.ts`       | **新規作成**                            | 5     |
| 7   | `src/main/parsers/index.ts`                        | 編集: import + register + export        | 5     |
| 8   | `src/main/parsers/error-patterns.ts`               | 編集: パターン定義 + レジストリ登録     | 6     |
| 9   | `src/renderer/hooks/agent/useAgentCapabilities.ts` | 確認のみ（変更不要）                    | 7     |
| 10  | `src/renderer/types/index.ts`                      | 確認のみ（変更不要）                    | 7     |

---

## 検証手順

### 1. TypeScript コンパイル

```bash
cd ~/dev/tools/Maestro
npm run lint          # 全 tsconfig でのType Check
npm run lint:eslint   # ESLint
```

### 2. CI テスト

```bash
npm run test          # agent-completeness.test.ts が最重要
```

期待される結果:

- `AGENT_IDS ↔ AGENT_DEFINITIONS consistency` → PASS
- `openclaw: has capabilities defined` → PASS
- `openclaw: has all required capability fields` → PASS
- `openclaw: has output parser if supportsJsonOutput` → PASS
- `openclaw: has error patterns if has output parser` → PASS
- `no orphaned capabilities` → PASS

### 3. 実行テスト

```bash
# Maestro を開発モードで起動
npm run dev

# UI で OpenClaw エージェントを作成し、メッセージを送信
# OpenClaw バイナリが PATH にあれば自動検出される
```

### 4. OpenClaw JSON 出力の実地確認

```bash
# 実際のJSON出力を確認して Parser のマッピングを調整
openclaw agent --agent main --message "hello" --json 2>&1 | head -50
```

---

## 注意事項

### Tabs インデント

Maestro のコードベースは**タブ**でインデントする（スペース不可）。
`CLAUDE.md` に明記: "This codebase uses **tabs for indentation**, not spaces."

### AgentError 型の参照

`AgentError` は `src/shared/types.ts` で定義されている。
Parser の `detectError*` メソッドの返り値型として使用する。

### 破壊的変更の回避

既存のエージェント定義・型定義を変更しない。追加のみ。

### OpenClaw の `--json` 出力フォーマット（実機確認済み）

OpenClaw の `--json` 出力は**JSONL ストリームではなく、単一 JSON オブジェクト**。
構造: `{ payloads: [{ text, mediaUrl }], meta: { durationMs, agentMeta: { sessionId, provider, model, usage } } }`

stderr には ANSI カラー付きのデバッグログが流れる（`[agent/embedded]` 等）。
Parser は stderr のログ行を無視し、stdout の JSON のみをパースする。

将来 OpenClaw が JSONL ストリーミング出力をサポートした場合は、
`usesJsonLineOutput` と `supportsStreaming` を `true` に変更し、
Parser のイベントマッピングを追加すること。

---

## アーキテクチャ図

```
┌─────────────────────────────────────────────────────────┐
│                     Maestro UI                           │
│  InputArea → MainPanel → AgentSessionsBrowser           │
└──────────────────────────┬──────────────────────────────┘
                           │ IPC
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  Capability Gates                        │
│  useAgentCapabilities('openclaw')                       │
│  → supportsResume: true, supportsBatchMode: true, ...   │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│               Process Manager                            │
│  Spawns: openclaw agent --json --message "prompt"       │
│  Parses: stdout via OpenClawOutputParser                │
└──────────────────────────┬──────────────────────────────┘
                           │ JSONL stdout
                           ▼
┌─────────────────────────────────────────────────────────┐
│             OpenClawOutputParser                         │
│  JSON line → ParsedEvent { type, text, sessionId, ... } │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Error Pattern Matching (OPENCLAW_ERROR_PATTERNS)       │
│  → auth_expired, rate_limited, network_error, ...       │
└─────────────────────────────────────────────────────────┘
```

---

## 将来の拡張（Phase 2+）

| 機能            | 対応フラグ                          | 実装内容                          |
| --------------- | ----------------------------------- | --------------------------------- |
| Session Storage | `supportsSessionStorage: true`      | OpenClaw セッション履歴の読み込み |
| Cost Tracking   | `supportsCostTracking: true`        | OpenClaw の課金情報パース         |
| Usage Stats     | `supportsUsageStats: true`          | トークン使用量の表示              |
| Image Input     | `supportsImageInput: true`          | ファイル添付の対応                |
| Context Merge   | `supportsContextMerge: true`        | 他セッションのコンテキスト統合    |
| Group Chat      | `supportsGroupChatModeration: true` | マルチエージェントモデレーション  |
| Wizard          | `supportsWizard: true`              | インラインウィザード対応          |

---

_Generated from Maestro v0.15.3 source code analysis on 2026-04-02_
