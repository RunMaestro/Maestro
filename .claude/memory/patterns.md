# Implementation Patterns

## Settings Persistence

```typescript
// 1. State with default
const [mySetting, setMySettingState] = useState(defaultValue);

// 2. Wrapper that persists
const setMySetting = (value) => {
  setMySettingState(value);
  window.maestro.settings.set('mySetting', value);
};

// 3. Load from batch in useEffect
const allSettings = await window.maestro.settings.getAll();
if (allSettings['mySetting'] !== undefined) setMySettingState(allSettings['mySetting']);
```

## Adding a Modal

1. Create component in `src/renderer/components/`
2. Add priority in `src/renderer/constants/modalPriorities.ts`
3. Register with layer stack (use `onCloseRef` pattern to avoid re-registration):
```typescript
const onCloseRef = useRef(onClose);
onCloseRef.current = onClose;
useEffect(() => {
  if (isOpen) {
    const id = registerLayer({
      type: 'modal',
      priority: MODAL_PRIORITIES.YOUR_MODAL,
      onEscape: () => onCloseRef.current(),
    });
    return () => unregisterLayer(id);
  }
}, [isOpen, registerLayer, unregisterLayer]); // onClose NOT in deps
```

## Theme Colors

13 required colors per theme. Use inline styles for theme colors:
```typescript
style={{ color: theme.colors.textMain }}  // Correct
className="text-gray-500"                  // Wrong for themed text
```
Use Tailwind for layout only.

## Encore Features (Feature Gating)

Gate ALL access points when adding new Encore Features:
1. Type flag → `EncoreFeatureFlags` in `src/renderer/types/index.ts`
2. Default `false` → `useSettings.ts`
3. Toggle UI → SettingsModal Encore tab
4. App.tsx → conditional rendering + callbacks
5. Keyboard shortcuts → guard with `ctx.encoreFeatures?.yourFeature`
6. Hamburger menu → make setter optional, conditional render
7. Command palette → pass `undefined` handler when disabled

## Execution Queue

Messages queue when AI is busy. Write ops queue sequentially; read-only can parallelize.

## Lazy Component Loading

Heavy modals loaded on-demand in App.tsx:
```typescript
const SettingsModal = lazy(() => import('./components/Settings/SettingsModal'));
```
