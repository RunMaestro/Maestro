<!-- Verified 2026-04-10 against origin/rc (06e5a2eb3) -->

# Test Patterns

Test infrastructure, conventions, mock setup, and patterns for the Maestro codebase.

---

## Test Configuration

### Vitest Setup

Config file: `vitest.config.mts`

```typescript
// Key settings:
environment: 'jsdom'; // Browser-like environment
pool: 'forks'; // Process isolation between test files
maxWorkers: 4; // Parallel execution
setupFiles: ['./src/__tests__/setup.ts'];
include: ['src/**/*.{test,spec}.{ts,tsx}'];
testTimeout: 10000;
hookTimeout: 10000;
teardownTimeout: 5000;

// Excluded from default run (need separate config or flags):
exclude: ['src/__tests__/integration/**', 'src/__tests__/e2e/**', 'src/__tests__/performance/**'];
```

Coverage uses `v8` provider with `text`, `text-summary`, `json`, and `html` reporters.

### Running Tests

```bash
npm run test          # Unit tests (excludes integration/e2e/performance)
npm run test:watch    # Watch mode
```

---

## File Organization

```text
src/
├── __tests__/
│   ├── setup.ts                          # Global test setup
│   ├── cli/
│   │   ├── commands/                     # CLI command tests
│   │   │   ├── list-agents.test.ts
│   │   │   ├── list-groups.test.ts
│   │   │   ├── list-playbooks.test.ts
│   │   │   ├── list-sessions.test.ts
│   │   │   ├── run-playbook.test.ts
│   │   │   ├── send.test.ts
│   │   │   ├── show-agent.test.ts
│   │   │   └── show-playbook.test.ts
│   │   ├── output/                       # CLI output formatter tests
│   │   │   ├── formatter.test.ts
│   │   │   └── jsonl.test.ts
│   │   └── services/                     # CLI service tests
│   │       ├── agent-sessions.test.ts
│   │       ├── agent-spawner.test.ts
│   │       ├── batch-processor.test.ts
│   │       ├── playbooks.test.ts
│   │       └── storage.test.ts
│   ├── renderer/
│   │   ├── components/                   # Component tests (*.test.tsx)
│   │   │   ├── ui/                       # Shared UI component tests
│   │   │   ├── shared/                   # Shared component tests
│   │   │   ├── DirectorNotes/
│   │   │   ├── DocumentGraph/
│   │   │   ├── History/
│   │   │   ├── InlineWizard/
│   │   │   ├── SessionList/
│   │   │   ├── Settings/
│   │   │   ├── UsageDashboard/
│   │   │   ├── Wizard/
│   │   │   └── *.test.tsx                # Individual component tests
│   │   ├── hooks/                        # Hook tests
│   │   │   ├── batch/
│   │   │   ├── keyboard/
│   │   │   ├── symphony/
│   │   │   └── *.test.ts
│   │   ├── stores/                       # Zustand store tests
│   │   │   └── *.test.ts
│   │   ├── contexts/                     # Context tests
│   │   ├── services/                     # Service tests
│   │   ├── types/                        # Type tests
│   │   └── utils/                        # Utility tests
│   ├── main/
│   │   ├── agents/                       # Agent definition/capability tests
│   │   ├── ipc/                          # IPC handler tests
│   │   ├── parsers/                      # Output parser tests
│   │   └── storage/                      # Storage tests
│   ├── shared/                           # Shared utility tests
│   ├── integration/                      # Integration tests (excluded from default run)
│   ├── e2e/                              # End-to-end tests (excluded from default run)
│   └── performance/                      # Performance tests (excluded from default run)
├── main/
│   ├── process-listeners/__tests__/      # Co-located listener tests
│   ├── process-manager/utils/__tests__/  # Co-located utility tests
│   └── runtime/__tests__/               # Co-located runtime tests
└── renderer/
    └── utils/__tests__/                  # Co-located renderer utility tests
```

### Co-located vs Centralized Tests

Most tests live under `src/__tests__/` mirroring the source structure. Some unit tests are co-located in `__tests__/` directories next to their source files (mainly in `src/main/`). Both patterns are valid. The centralized `src/__tests__/` directory is preferred for new tests.

---

## Global Test Setup

File: `src/__tests__/setup.ts`

The setup file configures the jsdom environment with mocks required by most tests:

### 1. Lucide React Icons (Proxy Mock)

All icon imports from `lucide-react` are auto-mocked via a `Proxy`:

```typescript
vi.mock('lucide-react', () => {
	return new Proxy(
		{},
		{
			get(_target, prop: string) {
				// Returns a mock SVG component with a data-testid
				return createMockIcon(prop);
			},
		}
	);
});
```

This means any `import { SomeIcon } from 'lucide-react'` works without listing every icon.

### 2. Shortcut Formatter

Mocked to always use non-Mac format (`Ctrl+` instead of platform-dependent output):

```typescript
vi.mock('../renderer/utils/shortcutFormatter', () => ({
	formatKey: vi.fn((key) => SHORTCUT_KEY_MAP[key] || key.toUpperCase()),
	formatShortcutKeys: vi.fn((keys, sep = '+') => keys.map(formatKey).join(sep)),
	formatMetaKey: vi.fn(() => 'Ctrl'),
	isMacOS: vi.fn(() => false),
}));
```

### 3. Browser APIs

```typescript
// matchMedia
window.matchMedia = vi.fn().mockImplementation((query) => ({
	matches: false, media: query, addEventListener: vi.fn(), ...
}));

// ResizeObserver - simulates 1000x500px layout
global.ResizeObserver = MockResizeObserver;

// IntersectionObserver
global.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn(),
}));

// Scroll methods
Element.prototype.scrollTo = vi.fn();
Element.prototype.scrollIntoView = vi.fn();

// offsetWidth (returns 1000 for responsive breakpoints)
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
	configurable: true,
	get() { return 1000; },
});
```

### 4. `window.maestro` Mock (IPC Bridge)

The complete Electron IPC bridge is mocked globally. This is the most important mock - it covers all `window.maestro.*` namespaces:

```typescript
const mockMaestro = {
	settings: {
		get: vi.fn().mockResolvedValue(undefined),
		set: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockResolvedValue({}),
	},
	sessions: {
		get: vi.fn().mockResolvedValue([]),
		save: vi.fn().mockResolvedValue(undefined),
		setAll: vi.fn().mockResolvedValue(undefined),
	},
	process: {
		spawn: vi.fn().mockResolvedValue({ pid: 12345 }),
		write: vi.fn().mockResolvedValue(undefined),
		kill: vi.fn().mockResolvedValue(undefined),
		onOutput: vi.fn().mockReturnValue(() => {}),
		onExit: vi.fn().mockReturnValue(() => {}),
	},
	git: { /* branch, status, diff, isRepo, worktreeSetup, createPR, ... */ },
	fs: { readDir, readFile, stat, directorySize, homeDir },
	agents: { detect, getConfig, setConfig, getCapabilities, ... },
	autorun: { readDoc, writeDoc, watchFolder, readFolder, listDocs },
	playbooks: { list, create, update, delete, export, import },
	notification: { speak, show, onCommandCompleted },
	dialog: { selectFolder, saveFile },
	shell: { openExternal, openPath, trashItem },
	stats: { recordQuery, getAggregation, ... },
	// ... many more namespaces
	platform: 'darwin',  // synchronous string
};

window.maestro = mockMaestro;
```

Individual tests can override specific methods:

```typescript
vi.mocked(window.maestro.settings.get).mockResolvedValue('custom-value');
```

---

## Common Mock Patterns

### Mocking Zustand Stores

Zustand stores are singletons. Two approaches:

**Approach 1: Direct setState (preferred for store tests)**

```typescript
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

beforeEach(() => {
	useSettingsStore.setState({
		settingsLoaded: false,
		activeThemeId: 'dracula',
		fontSize: 14,
		// ... reset all fields to initial values
	});
});
```

**Approach 2: vi.mock with selector function (for hook/component tests)**

```typescript
const mockSettingsState: Record<string, unknown> = {
	settingsLoaded: false,
	activeThemeId: 'dracula',
	setActiveThemeId: vi.fn(),
};

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector(mockSettingsState),
		{
			getState: () => mockSettingsState,
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));
```

### Mocking CLI Services

CLI tests mock storage and spawner services:

```typescript
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	getSessionById: vi.fn(),
	readSessions: vi.fn(),
}));

vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
	detectAgent: vi.fn(),
}));
```

### Mock Factories

#### Mock Session

```typescript
import type { SessionInfo } from '../../../shared/types';

const mockAgent = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id: 'agent-abc-123',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/path/to/project',
	projectRoot: '/path/to/project',
	...overrides,
});
```

#### Mock Theme

```typescript
import type { Theme } from '../../../renderer/types';

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
	},
};
```

#### Mock Toast

```typescript
import type { Toast } from '../../../renderer/stores/notificationStore';

function createToast(overrides: Partial<Toast> = {}): Toast {
	return {
		id: 'test-1',
		type: 'success',
		title: 'Test',
		message: 'Test message',
		timestamp: Date.now(),
		...overrides,
	};
}
```

### Mocking React-Markdown and Dependencies

Integration tests commonly mock the markdown rendering stack:

```typescript
vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));

vi.mock('remark-gfm', () => ({ default: {} }));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<code data-testid="syntax-highlighter">{children}</code>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));
```

---

## Rendering Patterns

### Rendering with LayerStackProvider

All components that use the modal system require `LayerStackProvider`:

```tsx
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';

const renderWithLayerStack = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

// Usage:
renderWithLayerStack(
	<ConfirmModal theme={testTheme} message="Are you sure?" onConfirm={vi.fn()} onClose={vi.fn()} />
);
```

For components that need re-rendering with new props:

```tsx
const renderWithProvider = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return {
		...result,
		rerender: (newUi: React.ReactElement) =>
			result.rerender(<LayerStackProvider>{newUi}</LayerStackProvider>),
	};
};
```

### renderHook + act Pattern

For testing hooks in isolation:

```typescript
import { renderHook, act } from '@testing-library/react';

it('should load settings on mount', async () => {
	const { result } = renderHook(() => useAppInitialization());

	await act(async () => {
		// trigger async effects
	});

	expect(result.current.someValue).toBe(expected);
});
```

### Testing Store Actions

```typescript
it('adds a toast', () => {
	const store = useNotificationStore.getState();
	store.addToast(createToast({ id: 'toast-1' }));
	expect(useNotificationStore.getState().toasts).toHaveLength(1);
});
```

---

## Timer Patterns

### Using Fake Timers

```typescript
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

it('auto-dismisses toast after duration', () => {
	notifyToast({ type: 'info', title: 'Test', message: 'Hi', duration: 5000 });

	expect(useNotificationStore.getState().toasts).toHaveLength(1);

	vi.advanceTimersByTime(5000);

	expect(useNotificationStore.getState().toasts).toHaveLength(0);
});
```

### Handling setTimeout in Components

Components using `setTimeout` or `requestAnimationFrame` need timers advanced:

```typescript
await act(async () => {
	vi.advanceTimersByTime(50); // FOCUS_AFTER_RENDER_DELAY_MS
});
```

---

## Integration Test Patterns

Integration tests live in `src/__tests__/integration/` and are excluded from the default test run. They test cross-component interactions.

### Example: AutoRun + Batch Processing

```typescript
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { AutoRun } from '../../renderer/components/AutoRun';

// Mock all external dependencies
vi.mock('react-markdown', () => ({ ... }));
vi.mock('../../renderer/components/AutoRunDocumentSelector', () => ({ ... }));

const renderWithProvider = (ui: React.ReactElement) => {
	const result = render(<LayerStackProvider>{ui}</LayerStackProvider>);
	return { ...result, rerender: ... };
};

it('locks editing during batch run', async () => {
	const ref = createRef<AutoRunHandle>();
	renderWithProvider(
		<AutoRun ref={ref} theme={mockTheme} batchRunState={runningState} ... />
	);

	// Verify the textarea is read-only
	const textarea = screen.getByRole('textbox');
	expect(textarea).toHaveAttribute('readOnly');
});
```

### Provider Integration

```typescript
it('syncs sessions across providers', async () => {
	// Setup mocks for IPC communication
	vi.mocked(window.maestro.process.spawn).mockResolvedValue({ pid: 111 });

	// Render with full provider tree
	render(
		<LayerStackProvider>
			<ComponentUnderTest />
		</LayerStackProvider>
	);

	// Interact and assert
	await act(async () => {
		fireEvent.click(screen.getByText('Connect'));
	});

	await waitFor(() => {
		expect(screen.getByText('Connected')).toBeInTheDocument();
	});
});
```

---

## Test Skeleton Template

Use this template as a starting point for new test files:

```typescript
/**
 * @file MyComponent.test.tsx
 * @description Tests for MyComponent
 *
 * Tests:
 * - Rendering with default and custom props
 * - User interactions (clicks, keyboard)
 * - State changes
 * - Error handling
 * - Accessibility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { MyComponent } from '../../../renderer/components/MyComponent';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../../renderer/types';

// ============================================================================
// Mocks
// ============================================================================

// Mock theme
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#242424',
		bgActivity: '#2a2a2a',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#3b82f6',
		accentForeground: '#ffffff',
		border: '#333333',
		error: '#ef4444',
		success: '#22c55e',
		warning: '#f59e0b',
	},
};

// Mock dependencies (add as needed)
// vi.mock('../../../renderer/stores/someStore', () => ({ ... }));

// ============================================================================
// Helpers
// ============================================================================

// Wrap with LayerStackProvider if component uses modals
const renderWithProvider = (ui: React.ReactElement) => {
	return render(<LayerStackProvider>{ui}</LayerStackProvider>);
};

// ============================================================================
// Tests
// ============================================================================

describe('MyComponent', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders with required props', () => {
			renderWithProvider(
				<MyComponent theme={mockTheme} onClose={vi.fn()} />
			);

			expect(screen.getByText('Expected Text')).toBeInTheDocument();
		});

		it('applies correct aria attributes', () => {
			renderWithProvider(
				<MyComponent theme={mockTheme} onClose={vi.fn()} />
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
		});
	});

	describe('interactions', () => {
		it('calls onClose when close button clicked', () => {
			const onClose = vi.fn();
			renderWithProvider(
				<MyComponent theme={mockTheme} onClose={onClose} />
			);

			fireEvent.click(screen.getByLabelText('Close modal'));
			expect(onClose).toHaveBeenCalledOnce();
		});

		it('handles keyboard input', async () => {
			renderWithProvider(
				<MyComponent theme={mockTheme} onClose={vi.fn()} />
			);

			const input = screen.getByRole('textbox');
			await act(async () => {
				fireEvent.change(input, { target: { value: 'test' } });
			});

			expect(input).toHaveValue('test');
		});
	});

	describe('state management', () => {
		it('updates when prop changes', () => {
			const { rerender } = renderWithProvider(
				<MyComponent theme={mockTheme} value="initial" onClose={vi.fn()} />
			);

			rerender(
				<LayerStackProvider>
					<MyComponent theme={mockTheme} value="updated" onClose={vi.fn()} />
				</LayerStackProvider>
			);

			expect(screen.getByText('updated')).toBeInTheDocument();
		});
	});

	describe('error handling', () => {
		it('shows error state', () => {
			renderWithProvider(
				<MyComponent theme={mockTheme} error="Something failed" onClose={vi.fn()} />
			);

			expect(screen.getByText('Something failed')).toBeInTheDocument();
		});
	});
});
```

### Hook Test Skeleton

```typescript
/**
 * @file useMyHook.test.ts
 * @description Tests for useMyHook
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock stores
const mockState: Record<string, unknown> = {
	someValue: 'default',
	setSomeValue: vi.fn(),
};

vi.mock('../../../renderer/stores/someStore', () => ({
	useSomeStore: Object.assign(
		(selector: (s: Record<string, unknown>) => unknown) => selector(mockState),
		{
			getState: () => mockState,
			setState: vi.fn(),
			subscribe: vi.fn(() => vi.fn()),
		}
	),
}));

import { useMyHook } from '../../../renderer/hooks/useMyHook';

describe('useMyHook', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockState.someValue = 'default';
	});

	it('returns initial state', () => {
		const { result } = renderHook(() => useMyHook());
		expect(result.current.someValue).toBe('default');
	});

	it('updates state on action', async () => {
		const { result } = renderHook(() => useMyHook());

		await act(async () => {
			result.current.doSomething('new-value');
		});

		expect(mockState.setSomeValue).toHaveBeenCalledWith('new-value');
	});
});
```

### Store Test Skeleton

```typescript
/**
 * @file myStore.test.ts
 * @description Tests for myStore Zustand store
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useMyStore } from '../../../renderer/stores/myStore';

function resetStore() {
	useMyStore.setState({
		items: [],
		loading: false,
	});
}

describe('myStore', () => {
	beforeEach(() => {
		resetStore();
		vi.clearAllMocks();
	});

	describe('initial state', () => {
		it('has empty items', () => {
			expect(useMyStore.getState().items).toEqual([]);
		});
	});

	describe('actions', () => {
		it('adds an item', () => {
			useMyStore.getState().addItem({ id: '1', name: 'Test' });
			expect(useMyStore.getState().items).toHaveLength(1);
		});

		it('removes an item', () => {
			useMyStore.setState({ items: [{ id: '1', name: 'Test' }] });
			useMyStore.getState().removeItem('1');
			expect(useMyStore.getState().items).toHaveLength(0);
		});
	});

	describe('selectors', () => {
		it('selects filtered items', () => {
			const result = selectActiveItems(useMyStore.getState());
			expect(result).toEqual([]);
		});
	});
});
```

---

## Key Testing Conventions

1. **Always wrap modal components** in `<LayerStackProvider>`.
2. **Use `vi.clearAllMocks()`** in `beforeEach` and `vi.restoreAllMocks()` in `afterEach`.
3. **Reset Zustand stores** explicitly since they persist across tests.
4. **Use `vi.useFakeTimers()`** when testing timeouts, intervals, or debouncing.
5. **Mock `window.maestro`** at the setup level; override specific methods per test.
6. **Use `data-testid`** for elements that lack accessible roles.
7. **Prefer `screen.getByRole`** and `screen.getByText` for queries (follows Testing Library best practices).
8. **Use `waitFor`** for async assertions and `act` for state updates.
9. **Mock external libraries** (react-markdown, lucide-react) to avoid rendering complexity.
10. **Test file naming**: `ComponentName.test.tsx` for components, `useHookName.test.ts` for hooks, `storeName.test.ts` for stores.
