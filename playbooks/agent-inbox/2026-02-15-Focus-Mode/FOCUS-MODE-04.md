# Phase 04: Conversation Tail — Log Rendering in FocusModeView

> **Feature:** Focus Mode (Inbox Triage View)
> **Codebase:** `~/Documents/Vibework/Maestro` | **Branch:** `feature/focus-mode`
> **Depends on:** Phase 03 (FocusModeView wired with keyboard)

This phase fills the FocusModeView body with the conversation tail — the last N log entries from the session's AITab. This is the core of Focus Mode: seeing what the agent said without leaving the inbox.

---

## Understand the Data Path

Before implementing, trace the data flow:
- `FocusModeView` receives `item: InboxItem` (has `sessionId`, `tabId`) and `sessions: Session[]`
- To get logs: `sessions.find(s => s.id === item.sessionId)` → `session.aiTabs.find(t => t.id === item.tabId)` → `tab.logs`
- `tab.logs` is `LogEntry[]` where each entry has `{ id, timestamp, source, text, ... }`
- Relevant `source` values for display: `'ai'`, `'user'`, `'system'`, `'error'`, `'tool'`, `'thinking'`
- Display only `'ai'` and `'user'` entries (skip system/tool/thinking for the triage view)
- Show last 20 entries max (configurable constant)

---

## Implement Conversation Tail

- [ ] **Replace the placeholder body in `src/renderer/components/AgentInbox/FocusModeView.tsx` with a conversation tail renderer.** Changes:

  1. **Add constants:**
     ```ts
     const MAX_LOG_ENTRIES = 20;
     const SOURCE_ICONS: Record<string, string> = {
     	ai: '🤖',
     	user: '👤',
     };
     ```

  2. **Compute the log entries** inside the component:
     ```ts
     const logs = useMemo(() => {
     	const session = sessions.find(s => s.id === item.sessionId);
     	if (!session) return [];
     	const tab = session.aiTabs.find(t => t.id === item.tabId);
     	if (!tab) return [];
     	// Filter to only show AI and user messages
     	const relevant = tab.logs.filter(log => log.source === 'ai' || log.source === 'user');
     	// Take last N entries
     	return relevant.slice(-MAX_LOG_ENTRIES);
     }, [sessions, item.sessionId, item.tabId]);
     ```

  3. **Auto-scroll ref:**
     ```ts
     const scrollRef = useRef<HTMLDivElement>(null);

     useEffect(() => {
     	if (scrollRef.current) {
     		scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
     	}
     }, [logs, item.sessionId, item.tabId]);
     ```

  4. **Render the body:**
     ```tsx
     <div
     	ref={scrollRef}
     	className="flex-1 overflow-y-auto px-4 py-3"
     	style={{ minHeight: 0 }}
     >
     	{logs.length === 0 ? (
     		<div
     			className="flex items-center justify-center h-full"
     			style={{ color: theme.colors.textDim }}
     		>
     			<span className="text-sm">No conversation yet</span>
     		</div>
     	) : (
     		<div className="flex flex-col gap-3">
     			{logs.map((log) => (
     				<LogBubble key={log.id} log={log} theme={theme} />
     			))}
     		</div>
     	)}
     </div>
     ```

  5. **Create the `LogBubble` sub-component** (inline in FocusModeView.tsx):
     ```tsx
     function LogBubble({ log, theme }: { log: LogEntry; theme: Theme }) {
     	const isAI = log.source === 'ai';
     	const icon = SOURCE_ICONS[log.source] ?? '💬';

     	return (
     		<div
     			className="flex gap-2"
     			style={{
     				flexDirection: isAI ? 'row' : 'row-reverse',
     			}}
     		>
     			{/* Source icon */}
     			<div
     				className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-xs"
     				style={{
     					backgroundColor: isAI
     						? `${theme.colors.accent}20`
     						: `${theme.colors.success}20`,
     				}}
     			>
     				{icon}
     			</div>

     			{/* Message content */}
     			<div
     				className="flex-1 rounded-lg px-3 py-2 text-sm"
     				style={{
     					backgroundColor: isAI
     						? `${theme.colors.bgActive}80`
     						: `${theme.colors.accent}10`,
     					color: theme.colors.textMain,
     					maxWidth: '85%',
     				}}
     			>
     				{/* Text content — preserve whitespace for code */}
     				<div
     					style={{
     						whiteSpace: 'pre-wrap',
     						wordBreak: 'break-word',
     						fontSize: 13,
     						lineHeight: 1.5,
     					}}
     				>
     					{truncateLogText(log.text)}
     				</div>

     				{/* Timestamp */}
     				<div
     					className="text-xs mt-1"
     					style={{ color: theme.colors.textDim, opacity: 0.7 }}
     				>
     					{formatRelativeTime(log.timestamp)}
     				</div>
     			</div>
     		</div>
     	);
     }
     ```

  6. **Add `truncateLogText` helper** (inline):
     ```ts
     const MAX_LOG_TEXT_LENGTH = 500;

     function truncateLogText(text: string): string {
     	if (text.length <= MAX_LOG_TEXT_LENGTH) return text;
     	return text.slice(0, MAX_LOG_TEXT_LENGTH) + '\n… (truncated)';
     }
     ```

  7. **Import** `formatRelativeTime` from `../../utils/formatters` (same formatter used by InboxListView for timestamps).

  8. **Import** `LogEntry` type from `../../types` (already exported).

  Run `npx tsc --noEmit` to verify.

---

## Handle Item Changes (Prev/Next)

- [ ] **Ensure the conversation tail updates and scrolls when navigating between items.** The `logs` useMemo already depends on `item.sessionId` and `item.tabId`, so it will recompute. The scroll-to-bottom `useEffect` also depends on these, so it will auto-scroll. Verify this works by reviewing the dependency arrays. No code changes needed if deps are correct — just verify.

  Also handle the edge case where `sessions.find()` returns undefined (session was deleted while focus mode is open):
  ```ts
  // In the body render, after logs computation:
  if (!sessions.find(s => s.id === item.sessionId)) {
  	return (
  		<div className="flex-1 flex items-center justify-center" style={{ color: theme.colors.textDim }}>
  			<span className="text-sm">Session no longer available</span>
  		</div>
  	);
  }
  ```

  Run `npx tsc --noEmit` to verify.

---

## Verification Gate

- [ ] **Run full verification.** Execute:
  ```bash
  cd ~/Documents/Vibework/Maestro && npx tsc --noEmit && npx vitest run && npx eslint src/renderer/components/AgentInbox/ --ext .ts,.tsx
  ```
  All tests must pass. No new tests in this phase (Phase 08 covers testing).

---

## Commit

- [ ] **Commit this phase.**
  ```bash
  git add src/renderer/components/AgentInbox/FocusModeView.tsx
  git commit -m "FOCUS-MODE: Phase 04 — conversation tail with LogBubble rendering"
  ```
