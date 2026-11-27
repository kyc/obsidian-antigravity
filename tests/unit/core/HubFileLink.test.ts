import {
  buildHubFileLinkBridgeScript,
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
    it('resolves POSIX, localhost, Windows, vscode-uri, encoded #, and malformed % segments', () => {
      expect(
        resolveVaultFileLink('file:///Users/alice/vault/Folder/Note%201.md#L15-L20', '/Users/alice/vault'),
      ).toEqual({
        relativePath: 'Folder/Note 1.md',
        line: 15,
        endLine: 20,
      });

      expect(
        resolveVaultFileLink('file://localhost/Users/alice/vault/100%ZZ.md', '/Users/alice/vault'),
      ).toEqual({
        relativePath: '100%ZZ.md',
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

    it('rejects sibling prefixes, traversal, external artifacts, directories, dotfiles, and non-vault schemes/hosts', () => {
      expect(resolveVaultFileLink('file:///mock/vault-backup/note.md', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/../secret.md', '/mock/vault')).toBeNull();
      expect(
        resolveVaultFileLink('file:///Users/alice/.gemini/antigravity/brain/123/plan.md', '/Users/alice/vault'),
      ).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/Folder/', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/.obsidian/app.json', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file:///mock/vault/.git/config', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('https://example.com/a.md', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('conversation://abc', '/mock/vault')).toBeNull();
      expect(resolveVaultFileLink('file://remote-host/mock/vault/a.md', '/mock/vault')).toBeNull();
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
    function makeEl(tagName: string, attrs: Record<string, string> = {}, parentElement: any = null) {
      const el: any = {
        tagName: tagName.toUpperCase(),
        attrs,
        parentElement,
        getAttribute: (name: string) => (name in attrs ? attrs[name] : null),
        hasAttribute: (name: string) => name in attrs,
        closest: (selector: string) => {
          const wantDataUri = selector.includes('[data-uri]');
          const wantAnchorHref = selector.includes('a[href]');
          let cur: any = el;
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
        console: { info: (msg: string) => consoleInfos.push(msg) },
      };
      const mockDocument = {
        addEventListener: jest.fn((type: string, fn: (evt: any) => void) => {
          listeners[type].push(fn);
        }),
      };

      const run = (script: string) => new Function('window', 'document', script)(mockWindow, mockDocument);
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
        for (const listener of listeners[type]) listener(evt);
        return evt;
      };

      return { listeners, consoleInfos, run, dispatch };
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

      const pill = makeEl('span', { role: 'button', 'data-uri': 'file:///c%3A/Users/Alice/Vault/Note.md#L4' });
      const innerTextSpan = makeEl('span', {}, pill);
      const evt1 = sandbox.dispatch('click', innerTextSpan);
      expect(evt1.preventDefault).toHaveBeenCalledTimes(1);
      expect(evt1.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      expect(parseHubFileLinkBridgeMessage(sandbox.consoleInfos[0], prefix)).toEqual({
        uri: 'file:///c%3A/Users/Alice/Vault/Note.md#L4',
        newTab: false,
      });

      const anchor = makeEl('a', { href: 'file:///C:/Users/Alice/Vault/Sub/Doc.md' });
      expect(sandbox.dispatch('click', anchor, { ctrlKey: true }).preventDefault).toHaveBeenCalledTimes(1);
      expect(parseHubFileLinkBridgeMessage(sandbox.consoleInfos[1], prefix)).toEqual({
        uri: 'file:///C:/Users/Alice/Vault/Sub/Doc.md',
        newTab: true,
      });

      expect(sandbox.dispatch('auxclick', anchor).preventDefault).toHaveBeenCalledTimes(1);
      expect(parseHubFileLinkBridgeMessage(sandbox.consoleInfos[2], prefix)).toEqual({
        uri: 'file:///C:/Users/Alice/Vault/Sub/Doc.md',
        newTab: true,
      });

      expect(sandbox.dispatch('click', pill, { altKey: true }).preventDefault).not.toHaveBeenCalled();
      expect(
        sandbox.dispatch('click', makeEl('span', { role: 'button', 'data-testid': 'comment-pill', 'data-uri': 'file:///C:/Users/Alice/Vault/Note.md' })).preventDefault,
      ).not.toHaveBeenCalled();
      expect(sandbox.dispatch('click', makeEl('div', { 'data-uri': 'file:///C:/Users/Alice/Vault/Note.md' })).preventDefault).not.toHaveBeenCalled();
      expect(sandbox.dispatch('click', makeEl('button', { 'data-uri': 'file:///C:/Users/Alice/.gemini/antigravity/brain/plan.md' })).preventDefault).not.toHaveBeenCalled();
      expect(sandbox.dispatch('click', makeEl('a', { href: 'file:///C:/Users/Alice/Vault/.obsidian/app.json' })).preventDefault).not.toHaveBeenCalled();
      expect(sandbox.dispatch('click', makeEl('a', { href: 'https://obsidian.md' })).preventDefault).not.toHaveBeenCalled();
      expect(sandbox.consoleInfos).toHaveLength(3);

      sandbox.run(
        buildHubFileLinkBridgeScript({
          enabled: false,
          vaultPath: 'C:\\Users\\Alice\\Vault',
          messagePrefix: prefix,
        }),
      );
      expect(sandbox.listeners.click).toHaveLength(1);
      expect(sandbox.dispatch('click', pill).preventDefault).not.toHaveBeenCalled();

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
