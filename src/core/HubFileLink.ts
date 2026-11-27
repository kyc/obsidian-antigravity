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

interface ParsedFileUri {
  fsPath: string;
  fragment: string;
  isDirectoryHint: boolean;
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizePosixOrDriveSegments(rawPath: string): string | null {
  const forward = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  const driveMatch = /^([a-zA-Z]:)(?:\/(.*))?$/.exec(forward);
  if (driveMatch) {
    const drive = driveMatch[1];
    const rest = driveMatch[2] ?? '';
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
    return stack.length > 0 ? `${drive}/${stack.join('/')}` : `${drive}/`;
  }

  if (forward.startsWith('/')) {
    const stack: string[] = [];
    for (const seg of forward.slice(1).split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        if (stack.length === 0) return null;
        stack.pop();
      } else {
        stack.push(seg);
      }
    }
    return `/${stack.join('/')}`;
  }

  return null;
}

/**
 * Normalizes a local vault directory path into a forward-slash root
 * with platform case-sensitivity metadata.
 */
export function normalizeVaultRoot(vaultPath: string): VaultRootInfo | null {
  const trimmed = (vaultPath || '').trim();
  if (!trimmed) return null;

  const forward = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  let root = forward;
  if (root.length > 1 && !/^[a-zA-Z]:\/$/.test(root)) {
    root = root.replace(/\/+$/, '');
  }

  if (!root) return null;
  const caseInsensitive = /^[a-zA-Z]:(\/|$)/.test(root);
  return { root, caseInsensitive };
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
 * Parses a `file:` URI into a normalized local filesystem path and raw fragment.
 */
export function fileUriToFsPath(rawUri: string): ParsedFileUri | null {
  const trimmed = (rawUri || '').trim();
  if (!/^file:/i.test(trimmed)) {
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

  const host = parsed.hostname.toLowerCase();
  if (host !== '' && host !== 'localhost') {
    return null;
  }

  const decodedPathname = parsed.pathname
    .split('/')
    .map((seg) => safeDecodeSegment(seg))
    .join('/')
    .replace(/\\/g, '/');

  const isDirectoryHint = decodedPathname.endsWith('/');
  const withoutLeadingDriveSlash = decodedPathname.replace(/^\/([a-zA-Z]:)(?=\/|$)/, '$1');
  const fsPath = normalizePosixOrDriveSegments(withoutLeadingDriveSlash);
  if (!fsPath) {
    return null;
  }

  return {
    fsPath,
    fragment: parsed.hash,
    isDirectoryHint,
  };
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

  return { subpath: safeDecodeSegment(stripped) };
}

/**
 * Resolves a `file:` URI to a vault-relative file path when it points to a
 * non-dotfile strictly inside `vaultPath`.
 */
export function resolveVaultFileLink(rawUri: string, vaultPath: string): ResolvedVaultFileLink | null {
  const vault = normalizeVaultRoot(vaultPath);
  const parsed = fileUriToFsPath(rawUri);
  if (!vault || !parsed || parsed.isDirectoryHint) {
    return null;
  }

  const prefix = vault.root.endsWith('/') ? vault.root : `${vault.root}/`;
  const targetComparable = vault.caseInsensitive ? parsed.fsPath.toLowerCase() : parsed.fsPath;
  const prefixComparable = vault.caseInsensitive ? prefix.toLowerCase() : prefix;

  if (!targetComparable.startsWith(prefixComparable)) {
    return null;
  }

  const relativePath = parsed.fsPath.slice(prefix.length);
  if (!relativePath) {
    return null;
  }

  const segments = relativePath.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) {
    return null;
  }

  return {
    relativePath,
    ...parseFileLinkFragment(parsed.fragment),
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

  return `(function(cfg){
  var key = '__obsidianAntigravityLinkBridge';
  var state = window[key] || (window[key] = { installed: false });
  state.enabled = cfg.enabled;
  state.vaultPrefix = cfg.vaultPrefix;
  state.caseInsensitive = cfg.caseInsensitive;
  state.messagePrefix = cfg.messagePrefix;
  if (state.installed) return;
  state.installed = true;

  function safeDecode(seg) {
    try { return decodeURIComponent(seg); } catch (e) { return seg; }
  }

  function normalizeSegments(rawPath) {
    var forward = rawPath.replace(/\\\\/g, '/').replace(/\\/+/g, '/');
    var driveMatch = /^([a-zA-Z]:)(?:\\/(.*))?$/.exec(forward);
    if (driveMatch) {
      var drive = driveMatch[1];
      var rest = driveMatch[2] || '';
      var stack = [];
      var parts = rest.split('/');
      for (var i = 0; i < parts.length; i++) {
        var seg = parts[i];
        if (!seg || seg === '.') continue;
        if (seg === '..') {
          if (stack.length === 0) return null;
          stack.pop();
        } else {
          stack.push(seg);
        }
      }
      return stack.length > 0 ? drive + '/' + stack.join('/') : drive + '/';
    }
    if (forward.charAt(0) === '/') {
      var pStack = [];
      var pParts = forward.slice(1).split('/');
      for (var j = 0; j < pParts.length; j++) {
        var pSeg = pParts[j];
        if (!pSeg || pSeg === '.') continue;
        if (pSeg === '..') {
          if (pStack.length === 0) return null;
          pStack.pop();
        } else {
          pStack.push(pSeg);
        }
      }
      return '/' + pStack.join('/');
    }
    return null;
  }

  function isVaultFileUri(rawUri) {
    if (!rawUri || !state.vaultPrefix || !/^file:/i.test(String(rawUri).trim())) return false;
    var parsed;
    try { parsed = new URL(String(rawUri).trim()); } catch (e) { return false; }
    if (parsed.protocol !== 'file:') return false;
    var host = (parsed.hostname || '').toLowerCase();
    if (host !== '' && host !== 'localhost') return false;
    var pathParts = parsed.pathname.split('/');
    for (var i = 0; i < pathParts.length; i++) {
      pathParts[i] = safeDecode(pathParts[i]);
    }
    var decoded = pathParts.join('/').replace(/\\\\/g, '/');
    if (decoded.endsWith('/')) return false;
    decoded = decoded.replace(/^\\/([a-zA-Z]:)(?=\\/|$)/, '$1');
    var fsPath = normalizeSegments(decoded);
    if (!fsPath) return false;
    var cmpTarget = state.caseInsensitive ? fsPath.toLowerCase() : fsPath;
    var cmpPrefix = state.caseInsensitive ? state.vaultPrefix.toLowerCase() : state.vaultPrefix;
    if (!cmpTarget.startsWith(cmpPrefix)) return false;
    var rel = fsPath.slice(state.vaultPrefix.length);
    if (!rel) return false;
    var relParts = rel.split('/');
    for (var k = 0; k < relParts.length; k++) {
      var s = relParts[k];
      if (!s || s === '.' || s === '..' || s.charAt(0) === '.') return false;
    }
    return true;
  }

  function handleEvent(evt, isAux) {
    if (!state.enabled || !state.vaultPrefix || evt.altKey) return;
    var newTab = false;
    if (isAux) {
      if (evt.button !== 1) return;
      newTab = true;
    } else {
      if (evt.button !== 0) return;
      newTab = Boolean(evt.ctrlKey || evt.metaKey);
    }
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

    if (!isVaultFileUri(rawUri)) return;

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
})(${configJson});`;
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

  const jsonPart = message.slice(expectedPrefix.length);
  let raw: unknown;
  try {
    raw = JSON.parse(jsonPart);
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
