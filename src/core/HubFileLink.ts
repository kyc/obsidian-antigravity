export interface ResolvedVaultFileLink {
  relativePath: string;
  line?: number;
  endLine?: number;
  subpath?: string;
}

export interface HubFileLinkBridgePayload {
  uri: string;
  newTab: boolean;
}

export interface VaultRootInfo {
  root: string;
  caseInsensitive: boolean;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Self-contained pure function shared between host validation and the
 * `<webview>` guest bridge (serialized via `.toString()`). Must not reference
 * any outer bindings so it remains standalone after minification.
 */
function extractVaultRelativePath(
  rawUri: string,
  vaultPrefix: string,
  caseInsensitive: boolean,
): string | null {
  const trimmed = (rawUri || '').trim();
  if (!vaultPrefix || !/^file:/i.test(trimmed)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') {
    return null;
  }

  const host = (parsed.hostname || '').toLowerCase();
  if (host !== '' && host !== 'localhost') {
    return null;
  }

  const rawParts = parsed.pathname.split('/');
  for (let i = 0; i < rawParts.length; i++) {
    try {
      rawParts[i] = decodeURIComponent(rawParts[i]);
    } catch {
      // Keep malformed percent-escape segments as-is
    }
  }
  let decoded = rawParts.join('/').replace(/\\/g, '/');
  if (decoded.endsWith('/')) {
    return null;
  }
  decoded = decoded.replace(/^\/([a-zA-Z]:)(?=\/|$)/, '$1').replace(/\/+/g, '/');

  let root = '';
  let rest = '';
  const driveMatch = /^([a-zA-Z]:)(?:\/(.*))?$/.exec(decoded);
  if (driveMatch) {
    root = driveMatch[1];
    rest = driveMatch[2] ?? '';
  } else if (decoded.startsWith('/')) {
    root = '';
    rest = decoded.slice(1);
  } else {
    return null;
  }

  const stack: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
    } else {
      stack.push(seg);
    }
  }

  const fsPath = `${root}/${stack.join('/')}`;
  const cmpTarget = caseInsensitive ? fsPath.toLowerCase() : fsPath;
  const cmpPrefix = caseInsensitive ? vaultPrefix.toLowerCase() : vaultPrefix;
  if (!cmpTarget.startsWith(cmpPrefix)) {
    return null;
  }

  const rel = fsPath.slice(vaultPrefix.length);
  if (!rel) {
    return null;
  }

  const relParts = rel.split('/');
  for (let i = 0; i < relParts.length; i++) {
    const s = relParts[i];
    if (!s || s === '.' || s === '..' || s.charAt(0) === '.') {
      return null;
    }
  }
  return rel;
}

/**
 * Normalizes a local vault directory path into a forward-slash root
 * with platform case-sensitivity metadata.
 */
export function normalizeVaultRoot(vaultPath: string): VaultRootInfo | null {
  const trimmed = (vaultPath || '').trim();
  if (!trimmed) return null;

  let root = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (root.length > 1 && !/^[a-zA-Z]:\/$/.test(root)) {
    root = root.replace(/\/+$/, '');
  }

  if (!root) return null;
  return { root, caseInsensitive: /^[a-zA-Z]:(\/|$)/.test(root) };
}

/**
 * Verifies that a `<webview>` URL matches the local Antigravity Hub origin
 * before injecting any DOM bridge script.
 */
export function isTrustedHubWebviewUrl(currentUrl: string, expectedHubUrl: string): boolean {
  if (!currentUrl || !expectedHubUrl) {
    return false;
  }

  let current: URL;
  let expected: URL;
  try {
    current = new URL(currentUrl);
    expected = new URL(expectedHubUrl);
  } catch {
    return false;
  }

  if (current.protocol !== 'http:' || current.origin !== expected.origin) {
    return false;
  }

  const host = current.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/**
 * Extracts line numbers or Obsidian subpaths from a URI fragment.
 */
export function parseFileLinkFragment(rawFragment: string): {
  line?: number;
  endLine?: number;
  subpath?: string;
} {
  const stripped = (rawFragment || '').replace(/^#/, '').trim();
  if (!stripped) {
    return {};
  }

  const lineMatch = /^L?(\d+)(?:[:C]\d+)?(?:-L?(\d+)(?:[:C]\d+)?)?$/i.exec(stripped);
  if (lineMatch) {
    const start = Number.parseInt(lineMatch[1], 10);
    if (Number.isInteger(start) && start >= 1) {
      const end = lineMatch[2] ? Number.parseInt(lineMatch[2], 10) : undefined;
      if (end !== undefined && Number.isInteger(end) && end >= start) {
        return { line: start, endLine: end };
      }
      return { line: start };
    }
  }

  return { subpath: safeDecode(stripped) };
}

/**
 * Resolves a `file:` URI to a vault-relative file path when it points to a
 * non-dotfile strictly inside `vaultPath`.
 */
export function resolveVaultFileLink(rawUri: string, vaultPath: string): ResolvedVaultFileLink | null {
  const vault = normalizeVaultRoot(vaultPath);
  if (!vault) {
    return null;
  }

  const prefix = vault.root.endsWith('/') ? vault.root : `${vault.root}/`;
  const relativePath = extractVaultRelativePath(rawUri, prefix, vault.caseInsensitive);
  if (!relativePath) {
    return null;
  }

  const fragment = new URL(rawUri.trim()).hash;
  return {
    relativePath,
    ...parseFileLinkFragment(fragment),
  };
}

/**
 * Builds an idempotent script injected into the Hub `<webview>` to intercept
 * clicks on vault-local file links and forward them over `console-message`.
 */
export function buildHubFileLinkBridgeScript(options: {
  enabled: boolean;
  vaultPath: string;
  messagePrefix: string;
}): string {
  const vault = normalizeVaultRoot(options.vaultPath);
  const vaultPrefix = vault ? (vault.root.endsWith('/') ? vault.root : `${vault.root}/`) : '';
  const configJson = JSON.stringify({
    enabled: Boolean(options.enabled),
    vaultPrefix,
    caseInsensitive: vault ? vault.caseInsensitive : false,
    messagePrefix: options.messagePrefix,
  });

  return `(function(cfg, extractRelPath){
  var key = '__obsidianAntigravityLinkBridge';
  var state = window[key] || (window[key] = { installed: false });
  state.enabled = cfg.enabled;
  state.vaultPrefix = cfg.vaultPrefix;
  state.caseInsensitive = cfg.caseInsensitive;
  state.messagePrefix = cfg.messagePrefix;
  if (state.installed) return;
  state.installed = true;

  function handleEvent(evt, isAux) {
    if (!state.enabled || !state.vaultPrefix || evt.altKey) return;
    var newTab = isAux ? evt.button === 1 : evt.button === 0;
    if (!newTab) return;
    newTab = isAux || Boolean(evt.ctrlKey || evt.metaKey);

    var rawTarget = evt.target;
    var targetEl = rawTarget && typeof rawTarget.closest === 'function'
      ? rawTarget
      : (rawTarget && rawTarget.parentElement);
    if (!targetEl || typeof targetEl.closest !== 'function') return;
    var el = targetEl.closest('[data-uri], a[href]');
    if (!el || el.getAttribute('data-testid') === 'comment-pill') return;

    var rawUri = null;
    if (el.hasAttribute('data-uri')) {
      var tag = el.tagName;
      var role = el.getAttribute('role');
      if (tag !== 'BUTTON' && tag !== 'A' && role !== 'button') return;
      rawUri = el.getAttribute('data-uri');
    } else {
      rawUri = el.getAttribute('href');
    }

    if (!extractRelPath(rawUri, state.vaultPrefix, state.caseInsensitive)) return;

    evt.preventDefault();
    if (typeof evt.stopImmediatePropagation === 'function') {
      evt.stopImmediatePropagation();
    } else if (typeof evt.stopPropagation === 'function') {
      evt.stopPropagation();
    }
    window.console.info(state.messagePrefix + JSON.stringify({ uri: rawUri, newTab: newTab }));
  }

  document.addEventListener('click', function(evt) { handleEvent(evt, false); }, true);
  document.addEventListener('auxclick', function(evt) { handleEvent(evt, true); }, true);
})(${configJson}, ${extractVaultRelativePath.toString()});`;
}

/**
 * Parses a console bridge payload emitted by the Hub `<webview>` guest script.
 */
export function parseHubFileLinkBridgeMessage(
  message: string,
  expectedPrefix: string,
): HubFileLinkBridgePayload | null {
  if (typeof message !== 'string' || !expectedPrefix || !message.startsWith(expectedPrefix)) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(message.slice(expectedPrefix.length));
  } catch {
    return null;
  }

  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.uri !== 'string' || record.uri.trim().length === 0) {
    return null;
  }

  return {
    uri: record.uri,
    newTab: Boolean(record.newTab),
  };
}
