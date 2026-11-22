// Mock for Obsidian API

export class Component {
  load = jest.fn();
  unload = jest.fn();
}

export class Plugin {
  app: any;
  manifest: any;

  constructor(app?: any, manifest?: any) {
    this.app = app;
    this.manifest = manifest;
  }

  addRibbonIcon = jest.fn();
  addCommand = jest.fn();
  addSettingTab = jest.fn();
  addStatusBarItem = jest.fn().mockImplementation(() => {
    const makeSpan = () => ({
      setText: jest.fn(),
      addClass: jest.fn(),
      empty: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
    });
    const makeDiv = () => ({
      title: '',
      addClass: jest.fn(),
      removeClass: jest.fn(),
      setText: jest.fn(),
      setAttr: jest.fn(),
      empty: jest.fn(),
      createSpan: jest.fn().mockImplementation(() => makeSpan()),
      addEventListener: jest.fn(),
    });
    return {
      ...makeDiv(),
      createDiv: jest.fn().mockImplementation(() => makeDiv()),
    };
  });
  registerView = jest.fn();
  registerEvent = jest.fn();
  registerDomEvent = jest.fn();
  register = jest.fn();
  loadData = jest.fn().mockResolvedValue({});
  saveData = jest.fn().mockResolvedValue(undefined);
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  settingItems: any[] = [];
  containerEl: any = {
    empty: jest.fn(),
    createEl: jest.fn().mockReturnValue({ createEl: jest.fn(), createDiv: jest.fn() }),
    createDiv: jest.fn().mockReturnValue({ createEl: jest.fn(), createDiv: jest.fn() }),
  };

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }

  getSettingDefinitions(): any[] {
    return [];
  }

  getControlValue(key: string): unknown {
    return this.plugin?.settings?.[key];
  }

  setControlValue(key: string, value: unknown): void | Promise<void> {
    if (this.plugin?.settings) {
      this.plugin.settings[key] = value;
      return this.plugin.saveData(this.plugin.settings);
    }
  }

  update() {
    this.settingItems = this.getSettingDefinitions();
  }
}

export class ItemView {
  app: any;
  leaf: any;
  contentEl: any;
  containerEl: any;

  constructor(leaf: any) {
    this.leaf = leaf;
    this.app = leaf?.app;
    const makeEl = (tag = 'div', opts?: any) => {
      const el: any = {
        tagName: tag.toUpperCase(),
        className: '',
        textContent: opts?.text ? String(opts.text) : '',
        type: opts?.type ?? '',
        parentEl: null as any,
        children: [] as any[],
        attributes: {} as Record<string, string>,
        empty: jest.fn(() => {
          el.children = [];
          el.textContent = '';
        }),
        addClass: jest.fn((...cls: string[]) => {
          el.className = [el.className, ...cls].filter(Boolean).join(' ');
        }),
        removeClass: jest.fn((...cls: string[]) => {
          const set = new Set(cls);
          el.className = el.className
            .split(/\s+/)
            .filter((c: string) => c && !set.has(c))
            .join(' ');
        }),
        remove: jest.fn(() => {
          if (el.parentEl?.children) {
            el.parentEl.children = el.parentEl.children.filter((c: any) => c !== el);
          }
          el.parentEl = null;
        }),
        setAttribute: jest.fn((key: string, val: string) => {
          el.attributes[key] = val;
        }),
        getAttribute: jest.fn((key: string) => el.attributes[key] ?? null),
        addEventListener: jest.fn(),
        createDiv: jest.fn((childOpts?: any) => {
          const normalized = typeof childOpts === 'string' ? { cls: childOpts } : childOpts;
          return el.createEl('div', normalized);
        }),
        createEl: jest.fn((childTag: string, childOpts?: any) => {
          const normalized = typeof childOpts === 'string' ? { cls: childOpts } : childOpts;
          const child = makeEl(childTag, normalized);
          child.parentEl = el;
          el.children.push(child);
          return child;
        }),
      };
      if (opts?.cls) {
        const clsList = Array.isArray(opts.cls) ? opts.cls : String(opts.cls).split(/\s+/);
        el.addClass(...clsList.filter(Boolean));
      }
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) {
          if (v !== null && v !== undefined) {
            el.setAttribute(k, String(v));
          }
        }
      }
      return el;
    };
    this.contentEl = makeEl();
    this.containerEl = {
      children: [{}, this.contentEl],
      empty: jest.fn(),
      addClass: jest.fn(),
      createDiv: jest.fn().mockImplementation((opts?: any) => makeEl('div', opts)),
      createEl: jest.fn().mockImplementation((tag: string, opts?: any) => makeEl(tag, opts)),
    };
  }

  addAction = jest.fn();
  onload(): void {}
  onunload(): void {}
  registerDomEvent = jest.fn();

  getViewType(): string {
    return '';
  }

  getDisplayText(): string {
    return '';
  }

  getIcon(): string {
    return '';
  }
}

export class FileView extends ItemView {
  allowNoFile = false;
  file: any = null;
  navigation = true;
}

export class WorkspaceLeaf {}

export class Scope {
  static instances: Scope[] = [];

  parent?: Scope;
  handlers: Array<{
    modifiers: string[] | null;
    key: string | null;
    func: (evt: KeyboardEvent, ctx?: unknown) => false | unknown;
  }> = [];

  constructor(parent?: Scope) {
    this.parent = parent;
    Scope.instances.push(this);
  }

  register = jest.fn((
    modifiers: string[] | null,
    key: string | null,
    func: (evt: KeyboardEvent, ctx?: unknown) => false | unknown
  ) => {
    const handler = { modifiers, key, func };
    this.handlers.push(handler);
    return handler;
  });

  unregister = jest.fn((handler: unknown) => {
    this.handlers = this.handlers.filter((entry) => entry !== handler);
  });
}

export const Platform = {
  isMacOS: true,
};

export class App {
  vault: any = {
    adapter: {
      basePath: '/mock/vault/path',
    },
    create: jest.fn().mockResolvedValue(undefined),
    append: jest.fn().mockResolvedValue(undefined),
    getAbstractFileByPath: jest.fn().mockReturnValue(null),
  };
  workspace: any = {
    layoutReady: true,
    onLayoutReady: jest.fn().mockImplementation((cb: () => any) => cb()),
    getLeavesOfType: jest.fn().mockReturnValue([]),
    getActiveViewOfType: jest.fn().mockReturnValue(null),
    getMostRecentLeaf: jest.fn().mockReturnValue(null),
    getRightLeaf: jest.fn().mockReturnValue({
      setViewState: jest.fn().mockResolvedValue(undefined),
    }),
    getLeftLeaf: jest.fn().mockReturnValue({
      setViewState: jest.fn().mockResolvedValue(undefined),
    }),
    getLeaf: jest.fn().mockReturnValue({
      setViewState: jest.fn().mockResolvedValue(undefined),
    }),
    setActiveLeaf: jest.fn(),
    revealLeaf: jest.fn(),
  };
}

export class MarkdownView {
  editor: any;
  file?: any;

  constructor(editor?: any, file?: any) {
    this.editor = editor;
    this.file = file;
  }
}

export class Setting {
  static instances: Setting[] = [];
  buttons: Array<{ text: string; clickHandler: (() => unknown) | null }> = [];

  constructor(containerEl: any) {
    Setting.instances.push(this);
  }
  setName = jest.fn().mockReturnThis();
  setDesc = jest.fn().mockReturnThis();
  addToggle = jest.fn().mockReturnThis();
  addTextArea = jest.fn().mockReturnThis();
  addButton = jest.fn((cb: (btn: any) => void) => {
    const record = { text: '', clickHandler: null as (() => unknown) | null };
    const btn = {
      setButtonText: jest.fn((text: string) => {
        record.text = text;
        return btn;
      }),
      setCta: jest.fn().mockReturnThis(),
      onClick: jest.fn((handler: () => unknown) => {
        record.clickHandler = handler;
        return btn;
      }),
    };
    cb(btn);
    this.buttons.push(record);
    return this;
  });
}

export class TextAreaComponent {
  inputEl: any;
  private _value = '';

  constructor(_container?: any) {
    this.inputEl = {
      addClass: jest.fn(),
      rows: 0,
      placeholder: '',
      focus: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
  }

  setValue(value: string): this {
    this._value = value;
    return this;
  }

  getValue(): string {
    return this._value;
  }
}

export class Modal {
  app: any;
  containerEl: any = {
    createDiv: jest.fn().mockReturnValue({
      createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
      createDiv: jest.fn().mockReturnValue({
        createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
        createDiv: jest.fn().mockReturnValue({
          createEl: jest.fn(),
        }),
        setText: jest.fn(),
      }),
      addClass: jest.fn(),
      setText: jest.fn(),
    }),
    empty: jest.fn(),
    addClass: jest.fn(),
  };
  contentEl: any = {
    createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
    createDiv: jest.fn().mockReturnValue({
      createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
      createSpan: jest.fn().mockReturnValue({}),
      createDiv: jest.fn().mockReturnValue({
        createEl: jest.fn().mockReturnValue({ addEventListener: jest.fn() }),
        createDiv: jest.fn().mockReturnValue({
          createEl: jest.fn(),
        }),
        setText: jest.fn(),
      }),
      addClass: jest.fn(),
      setText: jest.fn(),
    }),
    empty: jest.fn(),
    addClass: jest.fn(),
  };

  constructor(app: any) {
    this.app = app;
  }

  open(): void {}
  close(): void {}
  onOpen(): void | Promise<void> {}
  onClose(): void {}
}

class MockMenuItem {
  title = '';
  icon = '';
  disabled = false;
  checked: boolean | null = null;
  isLabel = false;
  clickHandler: (() => void) | null = null;

  setTitle = jest.fn((title: string) => {
    this.title = title;
    return this;
  });

  setIcon = jest.fn((icon: string) => {
    this.icon = icon;
    return this;
  });

  setDisabled = jest.fn((disabled: boolean) => {
    this.disabled = disabled;
    return this;
  });

  setChecked = jest.fn((checked: boolean | null) => {
    this.checked = checked;
    return this;
  });

  setIsLabel = jest.fn((isLabel: boolean) => {
    this.isLabel = isLabel;
    return this;
  });

  setWarning = jest.fn((_isWarning: boolean) => this);

  onClick = jest.fn((handler: () => void) => {
    this.clickHandler = handler;
    return this;
  });
}

export class Menu {
  static instances: Menu[] = [];

  items: MockMenuItem[] = [];
  useNativeMenu: boolean | null = null;
  showAtMouseEvent = jest.fn();
  showAtPosition = jest.fn();

  constructor() {
    Menu.instances.push(this);
  }

  addItem(callback: (item: MockMenuItem) => MockMenuItem | void): this {
    const item = new MockMenuItem();
    callback(item);
    this.items.push(item);
    return this;
  }

  addSeparator(): this {
    return this;
  }

  setUseNativeMenu = jest.fn((useNativeMenu: boolean) => {
    this.useNativeMenu = useNativeMenu;
    return this;
  });
}

const renderMarkdownMock = jest.fn<Promise<void>, [string, unknown, string, unknown]>().mockResolvedValue(undefined);

export const MarkdownRenderer = {
  render: jest.fn<Promise<void>, [unknown, string, unknown, string, unknown]>(
    (_app, markdown, el, sourcePath, component) => renderMarkdownMock(markdown, el, sourcePath, component),
  ),
  renderMarkdown: renderMarkdownMock,
};

export const loadPrism = jest.fn().mockResolvedValue({
  highlightElement: jest.fn(),
});

export const setIcon = jest.fn();

// Notice mock that tracks constructor calls
export const Notice = jest.fn().mockImplementation((_message: string, _timeout?: number) => {});

function unquoteYaml(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseYamlValue(rawValue: string): unknown {
  if (!rawValue) return null;

  if (rawValue.startsWith('{') && rawValue.endsWith('}')) {
    try { return JSON.parse(rawValue); } catch { /* fall through */ }
  }

  if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
    return rawValue.slice(1, -1).split(',').map(item => unquoteYaml(item.trim())).filter(Boolean);
  }

  if (rawValue === 'true' || rawValue === 'false') {
    return rawValue === 'true';
  }

  const numberValue = Number(rawValue);
  if (!Number.isNaN(numberValue) && rawValue !== '') {
    return numberValue;
  }

  return unquoteYaml(rawValue);
}

export function parseYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];
  let blockScalarKey: string | null = null;
  let blockScalarStyle: 'literal' | 'folded' | null = null;
  let blockScalarLines: string[] = [];
  let blockScalarIndent: number | null = null;

  const flushArray = () => {
    if (currentArrayKey) {
      result[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
    }
  };

  const flushBlockScalar = () => {
    if (!blockScalarKey) return;
    let value: string;
    if (blockScalarStyle === 'literal') {
      value = blockScalarLines.join('\n');
    } else {
      value = blockScalarLines.join('\n').replace(/(?<!\n)\n(?!\n)/g, ' ').trim();
    }
    result[blockScalarKey] = value;
    blockScalarKey = null;
    blockScalarStyle = null;
    blockScalarLines = [];
    blockScalarIndent = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle block scalar content
    if (blockScalarKey) {
      if (trimmed === '') {
        blockScalarLines.push('');
        continue;
      }
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (blockScalarIndent === null) {
        if (leadingSpaces === 0) {
          flushBlockScalar();
          // fall through to process this line
        } else {
          blockScalarIndent = leadingSpaces;
          blockScalarLines.push(line.slice(blockScalarIndent));
          continue;
        }
      } else if (leadingSpaces >= blockScalarIndent) {
        blockScalarLines.push(line.slice(blockScalarIndent));
        continue;
      } else {
        flushBlockScalar();
        // fall through
      }
    }

    // Handle YAML list items (- value)
    if (currentArrayKey && trimmed.startsWith('- ')) {
      currentArray.push(unquoteYaml(trimmed.slice(2).trim()));
      continue;
    }

    // Not a list item — flush any pending array
    if (currentArrayKey && trimmed !== '') {
      flushArray();
    }

    if (!trimmed) continue;

    const match = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;

    const key = match[1].trim();
    const rawValue = match[2].trim();
    if (!key) continue;

    // Check for block scalar indicator (| or >) with optional chomping
    const blockMatch = rawValue.match(/^([|>])([+-])?$/);
    if (blockMatch) {
      blockScalarKey = key;
      blockScalarStyle = blockMatch[1] === '|' ? 'literal' : 'folded';
      blockScalarLines = [];
      blockScalarIndent = null;
      continue;
    }

    if (!rawValue) {
      // Could be start of a YAML list or a null value — peek ahead
      currentArrayKey = key;
      currentArray = [];
      continue;
    }

    result[key] = parseYamlValue(rawValue);
  }

  if (blockScalarKey) flushBlockScalar();
  flushArray();

  return result;
}

// TFile class for instanceof checks
export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;

  constructor(path: string = '') {
    this.path = path;
    this.name = path.split('/').pop() || '';
    this.basename = this.name.replace(/\.[^.]+$/, '');
    this.extension = this.name.split('.').pop() || '';
  }
}

export class TFolder {
  path: string;
  name: string;
  children: any[] = [];

  constructor(path: string = '') {
    this.path = path;
    this.name = path.split('/').pop() || '';
  }
}

export class FileSystemAdapter {
  getBasePath(): string {
    return '';
  }
}

export function normalizePath(pathStr: string): string {
  if (!pathStr) return '';
  return pathStr.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
}

export const getLanguage = jest.fn(() => 'en');
