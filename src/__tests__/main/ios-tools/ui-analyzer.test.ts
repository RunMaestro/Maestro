/**
 * Tests for ui-analyzer.ts - UI tree analysis functions
 */

import {
  findElements,
  findElement,
  findByIdentifier,
  findByLabel,
  findByType,
  findByText,
  getInteractableElements,
  getButtons,
  getTextFields,
  getTextInputs,
  getTextElements,
  getNavigationElements,
  isInteractable,
  isTextElement,
  getSuggestedAction,
  describeElement,
  getBestIdentifier,
  filterVisible,
  filterEnabled,
  filterActive,
  sortByPosition,
  detectIssues,
  summarizeScreen,
} from '../../../main/ios-tools/ui-analyzer';
import { UIElement } from '../../../main/ios-tools/inspect-simple';

// =============================================================================
// Test Fixtures
// =============================================================================

function createUIElement(overrides: Partial<UIElement> = {}): UIElement {
  return {
    type: 'Other',
    frame: { x: 0, y: 0, width: 100, height: 50 },
    enabled: true,
    visible: true,
    traits: [],
    children: [],
    ...overrides,
  };
}

function createLoginScreen(): UIElement {
  return createUIElement({
    type: 'Application',
    identifier: 'app',
    children: [
      createUIElement({
        type: 'NavigationBar',
        label: 'Login',
        children: [
          createUIElement({
            type: 'Button',
            identifier: 'back_button',
            label: 'Back',
            frame: { x: 10, y: 50, width: 50, height: 44 },
          }),
        ],
      }),
      createUIElement({
        type: 'ScrollView',
        frame: { x: 0, y: 100, width: 393, height: 700 },
        children: [
          createUIElement({
            type: 'StaticText',
            label: 'Welcome to MyApp',
            frame: { x: 50, y: 120, width: 293, height: 30 },
          }),
          createUIElement({
            type: 'TextField',
            identifier: 'email_field',
            label: 'Email',
            placeholder: 'Enter your email',
            frame: { x: 20, y: 180, width: 353, height: 44 },
          }),
          createUIElement({
            type: 'SecureTextField',
            identifier: 'password_field',
            label: 'Password',
            placeholder: 'Enter your password',
            frame: { x: 20, y: 240, width: 353, height: 44 },
          }),
          createUIElement({
            type: 'Button',
            identifier: 'login_button',
            label: 'Log In',
            frame: { x: 20, y: 320, width: 353, height: 50 },
          }),
          createUIElement({
            type: 'Button',
            identifier: 'forgot_password',
            label: 'Forgot Password?',
            frame: { x: 100, y: 390, width: 193, height: 44 },
          }),
        ],
      }),
    ],
  });
}

function createEmptyStateScreen(): UIElement {
  return createUIElement({
    type: 'Application',
    children: [
      createUIElement({
        type: 'StaticText',
        label: 'No items found',
        frame: { x: 100, y: 300, width: 193, height: 30 },
      }),
      createUIElement({
        type: 'Button',
        identifier: 'get_started',
        label: 'Get Started',
        frame: { x: 100, y: 400, width: 193, height: 50 },
      }),
    ],
  });
}

function createScreenWithAccessibilityIssues(): UIElement {
  return createUIElement({
    type: 'Application',
    children: [
      // Button without label or identifier
      createUIElement({
        type: 'Button',
        frame: { x: 10, y: 10, width: 50, height: 50 },
        traits: ['Button'],
      }),
      // Button with small touch target
      createUIElement({
        type: 'Button',
        identifier: 'small_button',
        label: 'OK',
        frame: { x: 100, y: 10, width: 30, height: 30 },
      }),
      // Zero-size visible element
      createUIElement({
        type: 'Image',
        visible: true,
        frame: { x: 0, y: 0, width: 0, height: 0 },
      }),
      // Overlapping buttons
      createUIElement({
        type: 'Button',
        identifier: 'overlap1',
        label: 'Button 1',
        frame: { x: 200, y: 100, width: 100, height: 50 },
      }),
      createUIElement({
        type: 'Button',
        identifier: 'overlap2',
        label: 'Button 2',
        frame: { x: 250, y: 110, width: 100, height: 50 },
      }),
    ],
  });
}

// =============================================================================
// findElements and findElement tests
// =============================================================================

describe('findElements', () => {
  const tree = createLoginScreen();

  it('finds elements by identifier', () => {
    const result = findElements(tree, { identifier: 'login_button' });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].label).toBe('Log In');
  });

  it('finds elements by label', () => {
    const result = findElements(tree, { label: 'Email' });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].type).toBe('TextField');
  });

  it('finds elements by type', () => {
    const result = findElements(tree, { type: 'Button' });
    expect(result.elements).toHaveLength(3); // back, login, forgot password
  });

  it('finds elements by multiple types', () => {
    const result = findElements(tree, { type: ['TextField', 'SecureTextField'] });
    expect(result.elements).toHaveLength(2);
  });

  it('finds elements containing text', () => {
    const result = findElements(tree, { containsText: 'password' });
    expect(result.elements.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by visibility by default', () => {
    const treeWithHidden = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'Button', identifier: 'visible', visible: true }),
        createUIElement({ type: 'Button', identifier: 'hidden', visible: false }),
      ],
    });

    const result = findElements(treeWithHidden, { type: 'Button' });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].identifier).toBe('visible');
  });

  it('can include hidden elements', () => {
    const treeWithHidden = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'Button', identifier: 'visible', visible: true }),
        createUIElement({ type: 'Button', identifier: 'hidden', visible: false }),
      ],
    });

    const result = findElements(treeWithHidden, { type: 'Button', visible: false });
    expect(result.elements).toHaveLength(2);
  });

  it('supports regex matching for identifier', () => {
    const result = findElements(tree, { identifier: /^email/ });
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0].identifier).toBe('email_field');
  });

  it('supports custom predicate', () => {
    const result = findElements(tree, {
      predicate: (el) => el.frame.width > 300,
    });
    expect(result.elements.every((el) => el.frame.width > 300)).toBe(true);
  });

  it('returns total searched count', () => {
    const result = findElements(tree, { type: 'Button' });
    expect(result.totalSearched).toBeGreaterThan(0);
  });
});

describe('findElement', () => {
  const tree = createLoginScreen();

  it('returns first matching element', () => {
    const element = findElement(tree, { type: 'Button' });
    expect(element).not.toBeNull();
    expect(element?.type).toBe('Button');
  });

  it('returns null when no match', () => {
    const element = findElement(tree, { identifier: 'nonexistent' });
    expect(element).toBeNull();
  });
});

describe('findByIdentifier', () => {
  const tree = createLoginScreen();

  it('finds element by identifier', () => {
    const element = findByIdentifier(tree, 'login_button');
    expect(element).not.toBeNull();
    expect(element?.label).toBe('Log In');
  });

  it('returns null for unknown identifier', () => {
    const element = findByIdentifier(tree, 'unknown');
    expect(element).toBeNull();
  });
});

describe('findByLabel', () => {
  const tree = createLoginScreen();

  it('finds element by label', () => {
    const element = findByLabel(tree, 'Email');
    expect(element).not.toBeNull();
    expect(element?.type).toBe('TextField');
  });
});

describe('findByType', () => {
  const tree = createLoginScreen();

  it('finds all elements of type', () => {
    const result = findByType(tree, 'StaticText');
    expect(result.elements.length).toBeGreaterThan(0);
  });
});

describe('findByText', () => {
  const tree = createLoginScreen();

  it('finds elements containing text', () => {
    const result = findByText(tree, 'Login');
    expect(result.elements.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// getInteractableElements tests
// =============================================================================

describe('getInteractableElements', () => {
  const tree = createLoginScreen();

  it('returns all interactable elements', () => {
    const interactables = getInteractableElements(tree);
    expect(interactables.length).toBeGreaterThan(0);
  });

  it('includes suggested action', () => {
    const interactables = getInteractableElements(tree);
    expect(interactables.every((el) => el.suggestedAction)).toBe(true);
  });

  it('includes description', () => {
    const interactables = getInteractableElements(tree);
    expect(interactables.every((el) => el.description.length > 0)).toBe(true);
  });

  it('includes path', () => {
    const interactables = getInteractableElements(tree);
    expect(interactables.every((el) => el.path.length > 0)).toBe(true);
  });

  it('filters out invisible elements by default', () => {
    const treeWithHidden = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'Button', identifier: 'visible', visible: true }),
        createUIElement({ type: 'Button', identifier: 'hidden', visible: false }),
      ],
    });

    const interactables = getInteractableElements(treeWithHidden);
    expect(interactables.every((el) => el.visible)).toBe(true);
  });
});

// =============================================================================
// getButtons, getTextFields, getTextInputs tests
// =============================================================================

describe('getButtons', () => {
  const tree = createLoginScreen();

  it('returns all visible enabled buttons', () => {
    const buttons = getButtons(tree);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.type === 'Button')).toBe(true);
  });
});

describe('getTextFields', () => {
  const tree = createLoginScreen();

  it('returns text input fields', () => {
    const fields = getTextFields(tree);
    expect(fields.length).toBe(2); // email and password
  });

  it('includes secure text fields', () => {
    const fields = getTextFields(tree);
    expect(fields.some((f) => f.type === 'SecureTextField')).toBe(true);
  });
});

describe('getTextInputs', () => {
  const tree = createLoginScreen();

  it('is an alias for getTextFields', () => {
    const fields = getTextFields(tree);
    const inputs = getTextInputs(tree);
    expect(inputs).toEqual(fields);
  });
});

describe('getTextElements', () => {
  const tree = createLoginScreen();

  it('returns static text elements', () => {
    const texts = getTextElements(tree);
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.some((t) => t.type === 'StaticText')).toBe(true);
  });
});

describe('getNavigationElements', () => {
  const tree = createLoginScreen();

  it('returns navigation bar and similar elements', () => {
    const navElements = getNavigationElements(tree);
    expect(navElements.some((n) => n.type === 'NavigationBar')).toBe(true);
  });
});

// =============================================================================
// Element analysis tests
// =============================================================================

describe('isInteractable', () => {
  it('returns true for buttons', () => {
    const button = createUIElement({ type: 'Button' });
    expect(isInteractable(button)).toBe(true);
  });

  it('returns true for text fields', () => {
    const textField = createUIElement({ type: 'TextField' });
    expect(isInteractable(textField)).toBe(true);
  });

  it('returns false for static text', () => {
    const staticText = createUIElement({ type: 'StaticText' });
    expect(isInteractable(staticText)).toBe(false);
  });

  it('returns false for disabled elements', () => {
    const disabledButton = createUIElement({ type: 'Button', enabled: false });
    expect(isInteractable(disabledButton)).toBe(false);
  });

  it('returns false for invisible elements by default', () => {
    const hiddenButton = createUIElement({ type: 'Button', visible: false });
    expect(isInteractable(hiddenButton)).toBe(false);
  });

  it('can include invisible elements', () => {
    const hiddenButton = createUIElement({ type: 'Button', visible: false });
    expect(isInteractable(hiddenButton, false)).toBe(true);
  });
});

describe('isTextElement', () => {
  it('returns true for StaticText', () => {
    const text = createUIElement({ type: 'StaticText' });
    expect(isTextElement(text)).toBe(true);
  });

  it('returns true for TextField', () => {
    const field = createUIElement({ type: 'TextField' });
    expect(isTextElement(field)).toBe(true);
  });

  it('returns false for Image', () => {
    const image = createUIElement({ type: 'Image' });
    expect(isTextElement(image)).toBe(false);
  });
});

describe('getSuggestedAction', () => {
  it('suggests tap for buttons', () => {
    const button = createUIElement({ type: 'Button' });
    expect(getSuggestedAction(button)).toBe('tap');
  });

  it('suggests type for text fields', () => {
    const textField = createUIElement({ type: 'TextField' });
    expect(getSuggestedAction(textField)).toBe('type');
  });

  it('suggests toggle for switches', () => {
    const toggle = createUIElement({ type: 'Switch' });
    expect(getSuggestedAction(toggle)).toBe('toggle');
  });

  it('suggests scroll for scroll views', () => {
    const scrollView = createUIElement({ type: 'ScrollView' });
    expect(getSuggestedAction(scrollView)).toBe('scroll');
  });

  it('suggests select for pickers', () => {
    const picker = createUIElement({ type: 'Picker' });
    expect(getSuggestedAction(picker)).toBe('select');
  });
});

describe('describeElement', () => {
  it('includes type', () => {
    const button = createUIElement({ type: 'Button' });
    expect(describeElement(button)).toContain('Button');
  });

  it('includes identifier if present', () => {
    const button = createUIElement({ type: 'Button', identifier: 'submit' });
    expect(describeElement(button)).toContain('id="submit"');
  });

  it('includes label if no identifier', () => {
    const button = createUIElement({ type: 'Button', label: 'Submit' });
    expect(describeElement(button)).toContain('label="Submit"');
  });

  it('includes disabled state', () => {
    const button = createUIElement({ type: 'Button', enabled: false });
    expect(describeElement(button)).toContain('[disabled]');
  });

  it('includes hidden state', () => {
    const button = createUIElement({ type: 'Button', visible: false });
    expect(describeElement(button)).toContain('[hidden]');
  });
});

describe('getBestIdentifier', () => {
  it('prefers identifier', () => {
    const button = createUIElement({
      type: 'Button',
      identifier: 'submit_btn',
      label: 'Submit',
    });
    expect(getBestIdentifier(button)).toBe('id:submit_btn');
  });

  it('falls back to label', () => {
    const button = createUIElement({
      type: 'Button',
      label: 'Submit',
    });
    expect(getBestIdentifier(button)).toBe('label:Submit');
  });

  it('quotes labels with spaces', () => {
    const button = createUIElement({
      type: 'Button',
      label: 'Log In',
    });
    expect(getBestIdentifier(button)).toBe('label:"Log In"');
  });

  it('falls back to value', () => {
    const text = createUIElement({
      type: 'StaticText',
      value: 'Hello World',
    });
    expect(getBestIdentifier(text)).toBe('value:"Hello World"');
  });

  it('falls back to type', () => {
    const button = createUIElement({ type: 'Button' });
    expect(getBestIdentifier(button)).toBe('type:Button');
  });
});

// =============================================================================
// Filter and sort tests
// =============================================================================

describe('filterVisible', () => {
  it('filters to visible elements only', () => {
    const elements = [
      createUIElement({ visible: true }),
      createUIElement({ visible: false }),
      createUIElement({ visible: true }),
    ];
    const visible = filterVisible(elements);
    expect(visible).toHaveLength(2);
  });
});

describe('filterEnabled', () => {
  it('filters to enabled elements only', () => {
    const elements = [
      createUIElement({ enabled: true }),
      createUIElement({ enabled: false }),
      createUIElement({ enabled: true }),
    ];
    const enabled = filterEnabled(elements);
    expect(enabled).toHaveLength(2);
  });
});

describe('filterActive', () => {
  it('filters to visible and enabled elements', () => {
    const elements = [
      createUIElement({ visible: true, enabled: true }),
      createUIElement({ visible: false, enabled: true }),
      createUIElement({ visible: true, enabled: false }),
      createUIElement({ visible: true, enabled: true }),
    ];
    const active = filterActive(elements);
    expect(active).toHaveLength(2);
  });
});

describe('sortByPosition', () => {
  it('sorts by Y first, then X', () => {
    const elements = [
      createUIElement({ frame: { x: 100, y: 200, width: 50, height: 50 } }),
      createUIElement({ frame: { x: 50, y: 100, width: 50, height: 50 } }),
      createUIElement({ frame: { x: 150, y: 100, width: 50, height: 50 } }),
    ];
    const sorted = sortByPosition(elements);
    expect(sorted[0].frame.y).toBe(100);
    expect(sorted[0].frame.x).toBe(50);
    expect(sorted[1].frame.y).toBe(100);
    expect(sorted[1].frame.x).toBe(150);
    expect(sorted[2].frame.y).toBe(200);
  });

  it('does not modify original array', () => {
    const elements = [
      createUIElement({ frame: { x: 100, y: 200, width: 50, height: 50 } }),
      createUIElement({ frame: { x: 50, y: 100, width: 50, height: 50 } }),
    ];
    const originalFirst = elements[0];
    sortByPosition(elements);
    expect(elements[0]).toBe(originalFirst);
  });
});

// =============================================================================
// detectIssues tests
// =============================================================================

describe('detectIssues', () => {
  it('detects missing identifiers on interactive elements', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    const missingIdIssues = result.issues.filter((i) => i.type === 'missing_identifier');
    expect(missingIdIssues.length).toBeGreaterThan(0);
  });

  it('detects missing labels on buttons', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    const missingLabelIssues = result.issues.filter(
      (i) => i.type === 'missing_label' && i.element.type === 'Button'
    );
    expect(missingLabelIssues.length).toBeGreaterThan(0);
    expect(missingLabelIssues[0].severity).toBe('error');
  });

  it('detects zero-size visible elements', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    const zeroSizeIssues = result.issues.filter((i) => i.type === 'zero_size');
    expect(zeroSizeIssues.length).toBeGreaterThan(0);
  });

  it('detects small touch targets', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    const smallTargetIssues = result.issues.filter((i) => i.type === 'small_touch_target');
    expect(smallTargetIssues.length).toBeGreaterThan(0);
  });

  it('detects overlapping interactive elements', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    const overlapIssues = result.issues.filter((i) => i.type === 'overlapping_elements');
    expect(overlapIssues.length).toBeGreaterThan(0);
  });

  it('returns summary with counts by severity', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    expect(result.summary).toHaveProperty('errors');
    expect(result.summary).toHaveProperty('warnings');
    expect(result.summary).toHaveProperty('info');
    expect(result.summary).toHaveProperty('total');
    expect(result.summary.total).toBe(result.issues.length);
  });

  it('returns passed: false when there are errors', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    expect(result.summary.errors).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('returns passed: true for accessible screen', () => {
    const accessibleTree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({
          type: 'Button',
          identifier: 'submit',
          label: 'Submit',
          frame: { x: 100, y: 100, width: 100, height: 50 },
        }),
      ],
    });

    const result = detectIssues(accessibleTree);
    expect(result.passed).toBe(true);
  });

  it('includes element in each issue', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    expect(result.issues.every((i) => i.element !== undefined)).toBe(true);
  });

  it('includes suggestion for each issue', () => {
    const tree = createScreenWithAccessibilityIssues();
    const result = detectIssues(tree);

    expect(result.issues.every((i) => i.suggestion.length > 0)).toBe(true);
  });
});

// =============================================================================
// summarizeScreen tests
// =============================================================================

describe('summarizeScreen', () => {
  describe('login screen detection', () => {
    const tree = createLoginScreen();
    const summary = summarizeScreen(tree);

    it('detects login screen type', () => {
      expect(summary.screenType).toBe('login');
    });

    it('generates meaningful headline', () => {
      expect(summary.headline).toContain('Login');
    });

    it('includes key interactive elements', () => {
      expect(summary.keyElements.length).toBeGreaterThan(0);
    });

    it('includes available actions', () => {
      expect(summary.availableActions.length).toBeGreaterThan(0);
    });

    it('includes element counts', () => {
      expect(summary.counts.total).toBeGreaterThan(0);
      expect(summary.counts.buttons).toBeGreaterThan(0);
      expect(summary.counts.textFields).toBe(2);
    });

    it('generates prose description', () => {
      expect(summary.description).toContain('login');
    });
  });

  describe('empty state detection', () => {
    const tree = createEmptyStateScreen();
    const summary = summarizeScreen(tree);

    it('detects empty screen type', () => {
      expect(summary.screenType).toBe('empty');
    });

    it('includes visible text', () => {
      expect(summary.visibleText.some((t) => t.includes('No items'))).toBe(true);
    });
  });

  describe('form screen detection', () => {
    const tree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'TextField', identifier: 'field1', label: 'Name' }),
        createUIElement({ type: 'TextField', identifier: 'field2', label: 'Email' }),
        createUIElement({ type: 'TextField', identifier: 'field3', label: 'Phone' }),
        createUIElement({ type: 'TextField', identifier: 'field4', label: 'Address' }),
      ],
    });
    const summary = summarizeScreen(tree);

    it('detects form screen type', () => {
      expect(summary.screenType).toBe('form');
    });

    it('counts text fields correctly', () => {
      expect(summary.counts.textFields).toBe(4);
    });
  });

  describe('list screen detection', () => {
    const tree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({
          type: 'Table',
          children: [
            createUIElement({ type: 'Cell', label: 'Item 1' }),
            createUIElement({ type: 'Cell', label: 'Item 2' }),
            createUIElement({ type: 'Cell', label: 'Item 3' }),
          ],
        }),
      ],
    });
    const summary = summarizeScreen(tree);

    it('detects list screen type', () => {
      expect(summary.screenType).toBe('list');
    });
  });

  describe('settings screen detection', () => {
    const tree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'StaticText', label: 'Settings' }),
        createUIElement({ type: 'Switch', identifier: 'notifications', label: 'Notifications' }),
        createUIElement({ type: 'Switch', identifier: 'dark_mode', label: 'Dark Mode' }),
      ],
    });
    const summary = summarizeScreen(tree);

    it('detects settings screen type', () => {
      expect(summary.screenType).toBe('settings');
    });
  });

  describe('error screen detection', () => {
    const tree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'StaticText', label: 'Oops! Something went wrong' }),
        createUIElement({ type: 'Button', label: 'Try Again' }),
      ],
    });
    const summary = summarizeScreen(tree);

    it('detects error screen type', () => {
      expect(summary.screenType).toBe('error');
    });
  });

  describe('loading screen detection', () => {
    const tree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({ type: 'ActivityIndicator' }),
        createUIElement({ type: 'StaticText', label: 'Loading...' }),
      ],
    });
    const summary = summarizeScreen(tree);

    it('detects loading screen type', () => {
      expect(summary.screenType).toBe('loading');
    });
  });

  describe('navigation elements', () => {
    const tree = createUIElement({
      type: 'Application',
      children: [
        createUIElement({
          type: 'TabBar',
          children: [
            createUIElement({ type: 'Tab', label: 'Home' }),
            createUIElement({ type: 'Tab', label: 'Search' }),
            createUIElement({ type: 'Tab', label: 'Profile' }),
          ],
        }),
      ],
    });
    const summary = summarizeScreen(tree);

    it('includes navigation elements', () => {
      expect(summary.navigation.length).toBeGreaterThan(0);
    });
  });
});
