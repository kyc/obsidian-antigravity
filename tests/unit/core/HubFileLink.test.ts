import {
  buildHubFileLinkBridgeScript,
  fileUriToFsPath,
  isTrustedHubWebviewUrl,
  normalizeVaultRoot,
  parseFileLinkFragment,
  parseHubFileLinkBridgeMessage,
  resolveVaultFileLink,
} from '../../../src/core/HubFileLink';

describe('HubFileLink', () => {
  describe('isTrustedHubWebviewUrl', () => {
    it('accepts local hub origins and rejects about:blank, external origins, or mismatched ports', () => {
      const expected = 'http://127.0.0.1:4096/?section=test&hostTheme=dark&useWebSocket=true';
      expect(isTrustedHubWebviewUrl('http://127.0.0.1:4096/c/123', expected)).toBe(true);
      expect(isTrustedHubWebviewUrl('http://localhost:4096/', 'http://localhost:4096/?section=test')).toBe(true);
      expect(isTrustedHubWebviewUrl('http://[::1]:4096/', 'http://[::1]:4096/?section=test')).toBe(true);

      expect(isTrustedHubWebviewUrl('about:blank', expected)).toBe(false);
      expect(isTrustedHubWebviewUrl('https://accounts.google.com/signin', expected)).toBe(false);
      expect(isTrustedHubWebviewUrl('https://127.0.0.1:4096/', expected)).toBe(false);
      expect(isTrustedHubWebviewUrl('http://127.0.0.1:4097/', expected)).toBe(false);
      expect(isTrustedHubWebviewUrl('', expected)).toBe(false);
      expect(isTrustedHubWebviewUrl('http://127.0.0.1:4096/', '')).toBe(false);
    });
  });

  describe('normalizeVaultRoot', () => {
    it('normalizes POSIX and Windows vault paths with sensitivity metadata', () => {
      expect(normalizeVaultRoot('/Users/alice/vault/')).toEqual({
        root: '/Users/alice/vault',
        caseInsensitive: false,
      });
      expect(normalizeVaultRoot('C:\\Users\\Alice\\Vault\\')).toEqual({
        root: 'C:/Users/Alice/Vault',
        caseInsensitive: true,
      });
      expect(normalizeVaultRoot('   ')).toBeNull();
    });
  });

  describe('fileUriToFsPath', () => {
    it('parses POSIX, Windows, localhost, and vscode-uri encoded colons', () => {
      expect(fileUriToFsPath('file:///Users/alice/vault/note.md#L12')).toEqual({
        fsPath: '/Users/alice/vault/note.md',
        fragment: '#L12',
        isDirectoryHint: false,
      });
      expect(fileUriToFsPath('file://localhost/Users/alice/vault/note.md')).toEqual({
        fsPath: '/Users/alice/vault/note.md',
        fragment: '',
        isDirectoryHint: false,
      });
      expect(fileUriToFsPath('file:///C:/Users/Alice/Vault/note.md')).toEqual({
        fsPath: 'C:/Users/Alice/Vault/note.md',
        fragment: '',
        isDirectoryHint: false,
      });
      expect(fileUriToFsPath('file:///c%3A/Users/Alice/Vault/note.md#L3-L8')).toEqual({
        fsPath: 'c:/Users/Alice/Vault/note.md',
        fragment: '#L3-L8',
        isDirectoryHint: false,
      });
    });

    it('keeps %23 in filename while preserving #fragment and handles malformed escapes', () => {
      expect(fileUriToFsPath('file:///vault/C%23%20Notes%20%E4%B8%AD%E6%96%87.md#L10-L20')).toEqual({
        fsPath: '/vault/C# Notes 中文.md',
        fragment: '#L10-L20',
        isDirectoryHint: false,
      });
      expect(fileUriToFsPath('file:///vault/100%ZZ.md')).toEqual({
        fsPath: '/vault/100%ZZ.md',
        fragment: '',
        isDirectoryHint: false,
      });
    });

    it('rejects non-file schemes and non-local hosts', () => {
      expect(fileUriToFsPath('https://example.com/a.md')).toBeNull();
      expect(fileUriToFsPath('conversation://abc')).toBeNull();
      expect(fileUriToFsPath('sidecar://pane')).toBeNull();
      expect(fileUriToFsPath('obsidian://open?vault=v&file=a')).toBeNull();
      expect(fileUriToFsPath('file://remote-host/share/note.md')).toBeNull();
    });
  });

  describe('parseFileLinkFragment', () => {
    it('parses line, range, column, and heading subpaths', () => {
      expect(parseFileLinkFragment('')).toEqual({});
      expect(parseFileLinkFragment('#L12')).toEqual({ line: 12 });
      expect(parseFileLinkFragment('#L12-L34')).toEqual({ line: 12, endLine: 34 });
      expect(parseFileLinkFragment('#L12:5')).toEqual({ line: 12 });
      expect(parseFileLinkFragment('#L12C3-L14C9')).toEqual({ line: 12, endLine: 14 });
      expect(parseFileLinkFragment('#Section%20One')).toEqual({ subpath: 'Section One' });
    });
  });

  describe('resolveVaultFileLink', () => {
    it('resolves POSIX and Windows vault-local files with fragments', () => {
      expect(
        resolveVaultFileLink('file:///Users/alice/vault/Folder/Note%201.md#L15-L20', '/Users/alice/vault'),
      ).toEqual({
        relativePath: 'Folder/Note 1.md',
        line: 15,
        endLine: 20,
      });

      expect(
        resolveVaultFileLink(
          'file:///c%3A/users/alice/vault/Notes/C%23%20%E7%AC%94%E8%AE%B0.md#Heading%20A',
          'C:\\Users\\Alice\\Vault\\',
        ),
      ).toEqual({
        relativePath: 'Notes/C# 笔记.md',
        subpath: 'Heading A',
      });
    });

    it('rejects sibling prefixes, traversal, artifacts outside vault, directories, and dotfiles', () => {
      expect(resolveVaultFileLink('file:///mock/vault-backup/note.md', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/../secret.md', '/mock/vault')).toBeNull();
      expect(
        resolveVaultFileLink('file:///Users/alice/.gemini/antigravity/brain/123/plan.md', '/Users/alice/vault'),
      ).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/Folder/', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/.obsidian/app.json', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/.git/config', '/mock/vault')).toBeNull();
    });
  });

  describe('parseHubFileLinkBridgeMessage', () => {
    const prefix = '__OBSIDIAN_AGY_OPEN_FILE__:nonce123:';

    it('parses valid prefixed messages and rejects tampered or malformed ones', () => {
      expect(
        parseHubFileLinkBridgeMessage(`${prefix}${JSON.stringify({ uri: 'file:///v/a.md', newTab: true })}`, prefix),
      ).toEqual({ uri: 'file:///v/a.md', newTab: true });

      expect(parseHubFileLinkBridgeMessage('__OBSIDIAN_AGY_OPEN_FILE__:wrong:{"uri":"file:///v/a.md"}', prefix)).toBeNull();
      expect(parseHubFileLinkBridgeMessage(`${prefix}{bad json`, prefix)).toBeNull();
      expect(parseHubFileLinkBridgeMessage(`${prefix}{"uri":""}`, prefix)).toBeNull();
      expect(parseHubFileLinkBridgeMessage(`${prefix}null`, prefix)).toBeNull();
    });
  });

  describe('buildHubFileLinkBridgeScript', () => {
    interface MockEl {
      tagName: string;
      attrs: Record<string, string>;
      parentElement: MockEl | null;
      getAttribute: (name: string) => string | null;
      hasAttribute: (name: string) => boolean;
      closest: (selector: string) => MockEl | null;
    }

    function makeEl(tagName: string, attrs: Record<string, string> = {}, parentElement: MockEl | null = null): MockEl {
      const el: MockEl = {
        tagName: tagName.toUpperCase(),
        attrs,
        parentElement,
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        hasAttribute: (name: string) => name in attrs,
        closest: (selector: string) => {
          const wantDataUri = selector.includes('[data-uri]');
          const wantAnchorHref = selector.includes('a[href]');
          let cur: MockEl | null = el;
          while (cur) {
            if (wantDataUri && cur.hasAttribute('data-uri')) return cur;
            if (wantAnchorHref && cur.tagName === 'A' && cur.hasAttribute('href')) return cur;
            cur = cur.parentElement;
          }
          return null;
        },
      };
      return el;
    }

    function createGuestSandbox() {
      const listeners: Record<string, Array<(evt: any) => void>> = { click: [], auxclick: [] };
      const consoleInfos: string[] = [];
      const mockWindow: Record<string, any> = {
        console: {
          info: (msg: string) => {
            consoleInfos.push(msg);
          },
        },
      };
      const mockDocument = {
        addEventListener: jest.fn((type: string, fn: (evt: any) => void) => {
          listeners[type] = listeners[type] || [];
          listeners[type].push(fn);
        }),
      };

      const run = (script: string) => {
        const fn = new Function('window', 'document', script);
        fn(mockWindow, mockDocument);
      };

      const dispatch = (type: 'click' | 'auxclick', target: any, opts: Record<string, any> = {}) => {
        const evt = {
          button: type === 'auxclick' ? 1 : 0,
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          target,
          preventDefault: jest.fn(),
          stopImmediatePropagation: jest.fn(),
          stopPropagation: jest.fn(),
          ...opts,
        };
        for (const listener of listeners[type]) {
          listener(evt);
        }
        return evt;
      };

      return { listeners, consoleInfos, mockDocument, run, dispatch };
    }

    it('intercepts clickable vault IconPill and anchor links, supports modifiers, and stays idempotent', () => {
      const prefix = '__BRIDGE__:abc:';
      const sandbox = createGuestSandbox();
      sandbox.run(
        buildHubFileLinkBridgeScript({
          enabled: true,
          vaultPath: 'C:\\Users\\Alice\\Vault',
          messagePrefix: prefix,
        }),
      );

      expect(sandbox.listeners.click).toHaveLength(1);
      expect(sandbox.listeners.auxclick).toHaveLength(1);

      // 1. IconPill (<span role="button" data-uri="...">) with inner child span
      const pill = makeEl('span', { role: 'button', 'data-uri': 'file:///c%3A/Users/Alice/Vault/Note.md#L4' });
      const innerTextSpan = makeEl('span', {}, pill);
      const evt1 = sandbox.dispatch('click', innerTextSpan);
      expect(evt1.preventDefault).toHaveBeenCalledTimes(1);
      expect(evt1.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(sandbox.consoleInfos).toHaveLength(1);
      expect(parseHubFileLinkBridgeMessage(sandbox.consoleInfos[0], prefix)).toEqual({
        uri: 'file:///c%3A/Users/Alice/Vault/Note.md#L4',
        newTab: false,
      });

      // 2. Anchor link with Ctrl+Click and middle-click sets newTab: true
      const anchor = makeEl('a', { href: 'file:///C:/Users/Alice/Vault/Sub/Doc.md' });
      const evt2 = sandbox.dispatch('click', anchor, { ctrlKey: true });
      expect(evt2.preventDefault).toHaveBeenCalledTimes(1);
      expect(parseHubFileLinkBridgeMessage(sandbox.consoleInfos[1], prefix)).toEqual({
        uri: 'file:///C:/Users/Alice/Vault/Sub/Doc.md',
        newTab: true,
      });

      const evt3 = sandbox.dispatch('auxclick', anchor);
      expect(evt3.preventDefault).toHaveBeenCalledTimes(1);
      expect(parseHubFileLinkBridgeMessage(sandbox.consoleInfos[2], prefix)).toEqual({
        uri: 'file:///C:/Users/Alice/Vault/Sub/Doc.md',
        newTab: true,
      });

      // 3. Alt+Click, comment-pill, non-interactive breadcrumb div, external artifacts, dotfiles, and https are ignored
      expect(sandbox.dispatch('click', pill, { altKey: true }).preventDefault).not.toHaveBeenCalled();
      const commentPill = makeEl('span', {
        role: 'button',
        'data-testid': 'comment-pill',
        'data-uri': 'file:///C:/Users/Alice/Vault/Note.md',
      });
      expect(sandbox.dispatch('click', commentPill).preventDefault).not.toHaveBeenCalled();
      const breadcrumbDiv = makeEl('div', { 'data-uri': 'file:///C:/Users/Alice/Vault/Note.md' });
      expect(sandbox.dispatch('click', breadcrumbDiv).preventDefault).not.toHaveBeenCalled();
      const artifactBtn = makeEl('button', { 'data-uri': 'file:///C:/Users/Alice/.gemini/antigravity/brain/plan.md' });
      expect(sandbox.dispatch('click', artifactBtn).preventDefault).not.toHaveBeenCalled();
      const dotfileAnchor = makeEl('a', { href: 'file:///C:/Users/Alice/Vault/.obsidian/app.json' });
      expect(sandbox.dispatch('click', dotfileAnchor).preventDefault).not.toHaveBeenCalled();
      const webAnchor = makeEl('a', { href: 'https://obsidian.md' });
      expect(sandbox.dispatch('click', webAnchor).preventDefault).not.toHaveBeenCalled();
      expect(sandbox.consoleInfos).toHaveLength(3);

      // 4. Re-injecting with enabled=false disables interception without adding duplicate listeners
      sandbox.run(
        buildHubFileLinkBridgeScript({
          enabled: false,
          vaultPath: 'C:\\Users\\Alice\\Vault',
          messagePrefix: prefix,
        }),
      );
      expect(sandbox.listeners.click).toHaveLength(1);
      expect(sandbox.dispatch('click', pill).preventDefault).not.toHaveBeenCalled();

      // 5. Re-enabling restores interception dynamically
      sandbox.run(
        buildHubFileLinkBridgeScript({
          enabled: true,
          vaultPath: 'C:\\Users\\Alice\\Vault',
          messagePrefix: prefix,
        }),
      );
      expect(sandbox.listeners.click).toHaveLength(1);
      expect(sandbox.dispatch('click', pill).preventDefault).toHaveBeenCalledTimes(1);
    });
  });
});
