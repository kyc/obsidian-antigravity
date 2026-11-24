import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { Notice } from 'obsidian';
import { AgyHubManager, extractHubBootstrapToken } from '../../../src/core/AgyHubManager';
import {
  getHubDiscoveryFilePath,
  loadHubInstanceMetadata,
  saveHubInstanceMetadata,
} from '../../../src/core/AgyProfile';

describe('AgyHubManager', () => {
  let hubManager: AgyHubManager;
  let tmpHome: string;

  beforeEach(() => {
    // Every manager instance is pinned to a throwaway home so hub startup never
    // writes ~/.gemini on the machine running the suite.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hub-manager-test-'));
    hubManager = new AgyHubManager(tmpHome);
  });

  afterEach(() => {
    hubManager.stopHub();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('getHubUrl', () => {
    it('returns empty string when hub is not running / port is null', () => {
      expect(hubManager.getHubUrl()).toBe('');
    });

    it('returns base url with useWebSocket=true without extension bridge query params', () => {
      // Simulate active port via internal state or start
      (hubManager as unknown as { port: number }).port = 41891;

      const url = hubManager.getHubUrl();
      expect(url).toBe('http://127.0.0.1:41891/?useWebSocket=true');
      expect(url).toContain('useWebSocket=true');
      expect(url).not.toContain('extensionView');
      expect(url).not.toContain('extensionVariant');
    });

    it('appends hostTheme and useWebSocket=true when provided in options', () => {
      (hubManager as unknown as { port: number }).port = 41891;

      const darkUrl = hubManager.getHubUrl({ hostTheme: 'dark' });
      expect(darkUrl).toBe('http://127.0.0.1:41891/?hostTheme=dark&useWebSocket=true');

      const lightUrl = hubManager.getHubUrl({ hostTheme: 'light' });
      expect(lightUrl).toBe('http://127.0.0.1:41891/?hostTheme=light&useWebSocket=true');
    });

    it('appends #t=<bootstrapToken> after query string when bootstrapToken is present', () => {
      (hubManager as unknown as { port: number }).port = 41891;
      (hubManager as unknown as { bootstrapToken: string }).bootstrapToken = 'tok/abc+123';

      const url = hubManager.getHubUrl({ hostTheme: 'dark', section: 'obsidian-vault-1234abcd' });
      expect(url).toBe(
        'http://127.0.0.1:41891/?section=obsidian-vault-1234abcd&hostTheme=dark&useWebSocket=true#t=tok%2Fabc%2B123',
      );
    });
  });

  describe('extractHubBootstrapToken', () => {
    it('extracts token from localhost, 127.0.0.1, and IPv6 loopback URLs', () => {
      expect(
        extractHubBootstrapToken('  ➜  Open in your browser:  http://localhost:33357/#t=abc-123_XYZ\n'),
      ).toBe('abc-123_XYZ');
      expect(
        extractHubBootstrapToken('http://127.0.0.1:41000/#t=loopback-tok'),
      ).toBe('loopback-tok');
      expect(
        extractHubBootstrapToken('http://[::1]:41000/?foo=1#t=v6-tok'),
      ).toBe('v6-tok');
    });

    it('strips ANSI escape sequences and decodes URL-encoded tokens with extra hash params', () => {
      const ansiLine = '\u001b[32mOpen in your browser:\u001b[0m http://localhost:33357/?useWebSocket=true#foo=1&t=tok%2F123&bar=2\u001b[0m';
      expect(extractHubBootstrapToken(ansiLine)).toBe('tok/123');
    });

    it('returns null for non-matching lines or non-loopback hosts', () => {
      expect(extractHubBootstrapToken('Language server listening on port 33357')).toBeNull();
      expect(extractHubBootstrapToken('https://example.com:443/#t=secret')).toBeNull();
      expect(extractHubBootstrapToken('http://localhost:33357/#t=')).toBeNull();
      expect(extractHubBootstrapToken('')).toBeNull();
    });
  });

  describe('startHub', () => {
    it('consumes hub stdout and stderr so a chatty daemon cannot deadlock', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      // resume() must be called even though listeners are attached, since a
      // stream with no consumer blocks the child once the OS pipe fills.
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile');

      expect(stdout.listenerCount('data')).toBeGreaterThan(0);
      expect(stderr.listenerCount('data')).toBeGreaterThan(0);
      expect((stdout as any).resume).toHaveBeenCalled();
      expect((stderr as any).resume).toHaveBeenCalled();

      spawnSpy.mockRestore();
    });

    it('retains recent hub output and surfaces it when startup fails', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);

      // Hold the port wait open so the child exists and can log, mirroring the
      // real 15s startup window in which agy writes its diagnostics.
      let releaseWait: (err: Error) => void = () => {};
      const waitGate = new Promise<never>((_, reject) => {
        releaseWait = reject;
      });
      jest.spyOn(hubManager as any, 'waitForPort').mockReturnValue(waitGate);

      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile');

      // Wait until spawn has happened and the listeners are attached.
      while (stdout.listenerCount('data') === 0) {
        await new Promise((r) => setImmediate(r));
      }
      stdout.emit('data', Buffer.from('auth required: visit the login URL\n'));

      releaseWait(new Error('Timed out waiting for hub'));

      const err = await startPromise.catch((e: Error) => e);
      expect((err as Error).message).toContain('Timed out waiting for hub');
      expect((err as Error).message).toContain('auth required: visit the login URL');

      spawnSpy.mockRestore();
    });

    it('bounds retained hub output instead of growing without limit', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile');

      for (let i = 0; i < 500; i++) {
        stdout.emit('data', Buffer.from(`log line ${i}\n`));
      }

      const retained = hubManager.getRecentOutput().split('\n');
      expect(retained.length).toBeLessThanOrEqual(50);
      // The most recent line is kept, the earliest is dropped.
      expect(hubManager.getRecentOutput()).toContain('log line 499');
      expect(hubManager.getRecentOutput()).not.toContain('log line 0\n');

      spawnSpy.mockRestore();
    });

    it('passes --agent flag when defaultAgent is specified', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const fakeChild = {
          on: jest.fn(),
          kill: jest.fn(),
        };
        return fakeChild;
      });
      jest.spyOn(hubManager as unknown as { waitForPort: () => Promise<boolean> }, 'waitForPort').mockResolvedValue(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile', 'omarchy-vault');

      expect(spawnSpy).toHaveBeenCalledWith(
        '/bin/agy',
        expect.arrayContaining(['--agent=omarchy-vault', '--hub-port=42500', '--add-dir=/test/vault']),
        expect.any(Object),
      );

      spawnSpy.mockRestore();
    });

    it('passes --dangerously-skip-permissions when dangerouslySkipPermissions is true', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const fakeChild = {
          on: jest.fn(),
          kill: jest.fn(),
        };
        return fakeChild;
      });
      jest.spyOn(hubManager as unknown as { waitForPort: () => Promise<boolean> }, 'waitForPort').mockResolvedValue(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile', undefined, true);

      expect(spawnSpy).toHaveBeenCalledWith(
        '/bin/agy',
        expect.arrayContaining(['--dangerously-skip-permissions', '--hub-port=42500', '--add-dir=/test/vault']),
        expect.any(Object),
      );
      expect(hubManager.getDangerouslySkipPermissions()).toBe(true);

      spawnSpy.mockRestore();
    });

    it('omits --dangerously-skip-permissions when dangerouslySkipPermissions is false', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        const fakeChild = {
          on: jest.fn(),
          kill: jest.fn(),
        };
        return fakeChild;
      });
      jest.spyOn(hubManager as unknown as { waitForPort: () => Promise<boolean> }, 'waitForPort').mockResolvedValue(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'test-profile', undefined, false);

      const spawnArgs = spawnSpy.mock.calls[0][1];
      expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
      expect(hubManager.getDangerouslySkipPermissions()).toBe(false);

      spawnSpy.mockRestore();
    });

    it('shows a notice when profile authentication is missing on startHub', async () => {
      const childProcess = require('child_process');
      const agyProfile = require('../../../src/core/AgyProfile');
      const authSpy = jest.spyOn(agyProfile, 'ensureProfileInitialized').mockReturnValue(false);
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      (Notice as unknown as jest.Mock).mockClear();
      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'unauthenticated-profile');

      expect(Notice).toHaveBeenCalledWith(expect.stringContaining('Antigravity'));
      spawnSpy.mockRestore();
      authSpy.mockRestore();
    });

    it('coalesces concurrent startHub calls with the same profile into a single spawn', async () => {
      const childProcess = require('child_process');
      const fakeChild = {
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
      };
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fakeChild);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      const p1 = hubManager.startHub('/bin/agy', '/test/vault', 42500, 'profile-A');
      const p2 = hubManager.startHub('/bin/agy', '/test/vault', 42500, 'profile-A');

      const [url1, url2] = await Promise.all([p1, p2]);

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(url1).toBe(url2);
      expect(url1).toContain('42500');

      spawnSpy.mockRestore();
    });

    it('safely serializes concurrent startHub calls with different profiles without killing in-flight process', async () => {
      const childProcess = require('child_process');
      const spawnedProfiles: string[] = [];
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation((_exe: any, args: any) => {
        const profileArg = (args as string[]).find((a) => a.startsWith('--app_data_dir='));
        if (profileArg) spawnedProfiles.push(profileArg);
        return {
          on: jest.fn(),
          kill: jest.fn(),
          killed: false,
          exitCode: null,
        } as any;
      });

      let releaseA: () => void;
      const waitPromiseA = new Promise<void>((r) => { releaseA = r; });

      jest.spyOn(hubManager as any, 'waitForPort').mockImplementation((opts: { port: number }) => {
        if (opts.port === 41001) {
          return waitPromiseA;
        }
        return Promise.resolve();
      });

      const pA = hubManager.startHub('/bin/agy', '/test/vault', 41001, 'profile-A');
      const pB = hubManager.startHub('/bin/agy', '/test/vault', 41002, 'profile-B');

      releaseA!();

      const [urlA, urlB] = await Promise.all([pA, pB]);

      expect(urlA).toContain('41001');
      expect(urlB).toContain('41002');
      expect(spawnedProfiles).toEqual(['--app_data_dir=profile-A', '--app_data_dir=profile-B']);

      spawnSpy.mockRestore();
    });

    it('passes proxy environment variables when proxyUrl is provided', async () => {
      const childProcess = require('child_process');
      let capturedEnv: Record<string, string> | undefined;
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation((_exe: any, _args: any, options: any) => {
        capturedEnv = options.env;
        return {
          on: jest.fn(),
          kill: jest.fn(),
          killed: false,
          exitCode: null,
        } as any;
      });
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'proxy-profile', undefined, false, 'http://127.0.0.1:7897');

      expect(capturedEnv).toBeDefined();
      expect(capturedEnv?.HTTP_PROXY).toBe('http://127.0.0.1:7897');
      expect(capturedEnv?.NO_PROXY).toContain('127.0.0.1');
      expect(hubManager.getProxyUrl()).toBe('http://127.0.0.1:7897');

      spawnSpy.mockRestore();
    });

    it('restarts hub when proxyUrl changes', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
      } as any);
      const stopSpy = jest.spyOn(hubManager, 'stopHub');
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42501, 'restart-profile', undefined, false, 'http://127.0.0.1:7890');
      expect(hubManager.getProxyUrl()).toBe('http://127.0.0.1:7890');

      // Call startHub with different proxy
      await hubManager.startHub('/bin/agy', '/test/vault', 42502, 'restart-profile', undefined, false, 'http://127.0.0.1:7897');
      expect(stopSpy).toHaveBeenCalled();
      expect(hubManager.getProxyUrl()).toBe('http://127.0.0.1:7897');

      spawnSpy.mockRestore();
    });

    it('restarts hub when defaultAgent, preferredPort, or executable changes and reports config drift', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
      } as any);
      const stopSpy = jest.spyOn(hubManager, 'stopHub');
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      await hubManager.startHub('/bin/agy', '/test/vault', 42510, 'cfg-profile', 'agent-a', false, '');
      expect(hubManager.getExecutable()).toBe('/bin/agy');
      expect(hubManager.getDefaultAgent()).toBe('agent-a');
      expect(hubManager.getPreferredPort()).toBe(42510);
      expect(
        hubManager.hasConfigDrift({
          executable: '/bin/agy',
          profile: 'cfg-profile',
          vaultPath: '/test/vault',
          dangerouslySkipPermissions: false,
          proxyUrl: '',
          defaultAgent: 'agent-a',
          preferredPort: 42510,
        }),
      ).toBe(false);
      expect(
        hubManager.hasConfigDrift({
          executable: '/opt/agy-v2/agy',
          profile: 'cfg-profile',
          vaultPath: '/test/vault',
          dangerouslySkipPermissions: false,
          proxyUrl: '',
          defaultAgent: 'agent-a',
          preferredPort: 42510,
        }),
      ).toBe(true);
      expect(
        hubManager.hasConfigDrift({
          profile: 'cfg-profile',
          vaultPath: '/test/vault',
          dangerouslySkipPermissions: false,
          proxyUrl: '',
          defaultAgent: 'agent-b',
          preferredPort: 42510,
        }),
      ).toBe(true);

      await hubManager.startHub('/bin/agy', '/test/vault', 42510, 'cfg-profile', 'agent-b', false, '');
      expect(stopSpy).toHaveBeenCalledTimes(1);
      expect(hubManager.getDefaultAgent()).toBe('agent-b');

      await hubManager.startHub('/bin/agy', '/test/vault', 42511, 'cfg-profile', 'agent-b', false, '');
      expect(stopSpy).toHaveBeenCalledTimes(2);
      expect(hubManager.getPreferredPort()).toBe(42511);

      await hubManager.startHub('/opt/agy-v2/agy', '/test/vault', 42511, 'cfg-profile', 'agent-b', false, '');
      expect(stopSpy).toHaveBeenCalledTimes(3);
      expect(hubManager.getExecutable()).toBe('/opt/agy-v2/agy');

      spawnSpy.mockRestore();
    });

    it('preserves pending SIGKILL escalation timer across idempotent repeated stopHub calls', () => {
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const cancelSpy = jest.fn();
      const killSpy = jest.spyOn(AgyProcess, 'killProcess').mockReturnValue({ cancel: cancelSpy });

      (hubManager as any).hubProcess = { pid: 5555, killed: false, exitCode: null };
      (hubManager as any).port = 42500;
      (hubManager as any).currentProfile = 'test-profile';

      // First stopHub arms SIGKILL escalation
      hubManager.stopHub();
      expect(killSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).not.toHaveBeenCalled();

      // Repeated stopHub (e.g. beforeunload -> pagehide -> onunload) must NOT cancel it
      hubManager.stopHub();
      hubManager.stopHub();
      expect(cancelSpy).not.toHaveBeenCalled();

      killSpy.mockRestore();
    });

    it('aborts startHub before spawning if stopHub is called during stale cleanup', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn');
      let releaseCleanup: () => void = () => {};
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      const cleanupSpy = jest
        .spyOn(hubManager as any, 'performCleanupStaleHubs')
        .mockReturnValue(cleanupGate);

      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42530, 'cancel-cleanup-profile');

      // Wait until startHub enters performCleanupStaleHubs
      while (cleanupSpy.mock.calls.length === 0) {
        await Promise.resolve();
      }
      hubManager.stopHub();
      releaseCleanup();

      await expect(startPromise).rejects.toThrow(/cancelled/i);
      expect(spawnSpy).not.toHaveBeenCalled();

      spawnSpy.mockRestore();
      cleanupSpy.mockRestore();
    });

    it('aborts startHub before spawning if stopHub is called during port probe', async () => {
      const childProcess = require('child_process');
      const spawnSpy = jest.spyOn(childProcess, 'spawn');
      let releasePortProbe: () => void = () => {};
      const portGate = new Promise<void>((resolve) => {
        releasePortProbe = resolve;
      });
      jest.spyOn(hubManager as any, 'performCleanupStaleHubs').mockResolvedValue(undefined);
      const portSpy = jest
        .spyOn(hubManager as any, 'assertPortAvailable')
        .mockReturnValue(portGate);

      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42531, 'cancel-port-profile');

      while (portSpy.mock.calls.length === 0) {
        await Promise.resolve();
      }
      hubManager.stopHub();
      releasePortProbe();

      await expect(startPromise).rejects.toThrow(/cancelled/i);
      expect(spawnSpy).not.toHaveBeenCalled();

      spawnSpy.mockRestore();
      portSpy.mockRestore();
    });

    it('immediately kills spawning child, removes metadata, and aborts waitForPort when stopHub is called mid-startup', async () => {
      const childProcess = require('child_process');
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const fakeChild: any = new EventEmitter();
      fakeChild.pid = 81234;
      fakeChild.killed = false;
      fakeChild.exitCode = null;
      fakeChild.signalCode = null;
      fakeChild.kill = jest.fn(() => {
        fakeChild.killed = true;
        return true;
      });

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue(fakeChild);
      const killProcessSpy = jest.spyOn(AgyProcess, 'killProcess').mockImplementation((child: any) => {
        child.kill('SIGTERM');
        return { cancel: jest.fn() };
      });
      jest.spyOn(hubManager as any, 'performCleanupStaleHubs').mockResolvedValue(undefined);
      jest.spyOn(hubManager as any, 'assertPortAvailable').mockResolvedValue(undefined);

      let waitEntered = false;
      let capturedIsCancelled: (() => boolean) | undefined;
      let releaseProbe: () => void = () => {};
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const waitSpy = jest
        .spyOn(hubManager as any, 'waitForPort')
        .mockImplementation(async (opts: { isCancelled?: () => boolean }) => {
          waitEntered = true;
          capturedIsCancelled = opts.isCancelled;
          await probeGate;
          if (opts.isCancelled?.()) {
            throw new Error('Antigravity hub start was cancelled.');
          }
        });

      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42532, 'mid-spawn-cancel');

      while (!waitEntered) {
        await Promise.resolve();
      }
      expect(capturedIsCancelled?.()).toBe(false);

      // stopHub must synchronously kill the spawning child before waitForPort even returns
      hubManager.stopHub();
      expect(killProcessSpy).toHaveBeenCalledWith(fakeChild, true);
      expect(capturedIsCancelled?.()).toBe(true);
      expect(loadHubInstanceMetadata('mid-spawn-cancel', tmpHome)).toBeNull();

      releaseProbe();
      await expect(startPromise).rejects.toThrow(/cancelled/i);

      waitSpy.mockRestore();
      killProcessSpy.mockRestore();
      spawnSpy.mockRestore();
    });

    it('captures #t=<token> emitted shortly after waitForPort, redacts diagnostics, and clears on stopHub', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        off: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42505, 'token-profile');

      setTimeout(() => {
        stdout.emit(
          'data',
          Buffer.from('  ➜  Open in your browser:  http://localhost:42505/#t=super-secret-bootstrap-token\n'),
        );
      }, 25);

      const returnedUrl = await startPromise;
      expect(returnedUrl).toContain('#t=super-secret-bootstrap-token');
      expect(hubManager.getHubUrl({ hostTheme: 'dark' })).toContain('#t=super-secret-bootstrap-token');
      expect(hubManager.getRecentOutput()).toContain('#t=[REDACTED]');
      expect(hubManager.getRecentOutput()).not.toContain('super-secret-bootstrap-token');

      hubManager.stopHub();
      expect((hubManager as unknown as { bootstrapToken: string | null }).bootstrapToken).toBeNull();

      spawnSpy.mockRestore();
    });

    it('falls back cleanly without #t= when hub stdout never emits a bootstrap token', async () => {
      const childProcess = require('child_process');
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        on: jest.fn(),
        off: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      } as any);
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);
      const waitTokenSpy = jest
        .spyOn(hubManager as any, 'waitForBootstrapToken')
        .mockResolvedValue(undefined);

      const returnedUrl = await hubManager.startHub('/bin/agy', '/test/vault', 42506, 'legacy-profile');
      expect(waitTokenSpy).toHaveBeenCalled();
      expect(returnedUrl).not.toContain('#t=');
      expect(hubManager.getHubUrl()).not.toContain('#t=');

      spawnSpy.mockRestore();
    });

    it('resolves waitForBootstrapToken cleanly after timeout when no token arrives', async () => {
      const fakeChild = {
        on: jest.fn(),
        off: jest.fn(),
        killed: false,
        exitCode: null,
      } as any;

      await expect(
        (hubManager as any).waitForBootstrapToken(fakeChild, () => null, jest.fn(), 20),
      ).resolves.toBeUndefined();
    });

    const withMockMintHub = async (
      pid: number,
      handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
      run: (ctx: {
        manager: AgyHubManager;
        port: number;
        tmpHome: string;
        stdout: EventEmitter;
        writeDiscovery: (profile: string, data: Record<string, unknown>) => void;
      }) => Promise<void>,
    ) => {
      const childProcess = require('child_process');
      const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-hub-mint-'));
      const manager = new AgyHubManager(tmpHome);
      const server = http.createServer(handler);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as net.AddressInfo).port;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      (stdout as any).resume = jest.fn();
      (stderr as any).resume = jest.fn();

      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockReturnValue({
        pid,
        on: jest.fn(),
        off: jest.fn(),
        kill: jest.fn(),
        killed: false,
        exitCode: null,
        stdout,
        stderr,
      });
      const assertPortSpy = jest.spyOn(manager as any, 'assertPortAvailable').mockResolvedValue(undefined);
      const waitPortSpy = jest.spyOn(manager as any, 'waitForPort').mockResolvedValue(undefined);

      try {
        await run({
          manager,
          port,
          tmpHome,
          stdout,
          writeDiscovery: (profile, data) => {
            const p = getHubDiscoveryFilePath(profile, port, tmpHome);
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, JSON.stringify(data));
          },
        });
      } finally {
        manager.stopHub();
        waitPortSpy.mockRestore();
        assertPortSpy.mockRestore();
        spawnSpy.mockRestore();
        await new Promise<void>((r) => server.close(() => r()));
        fs.rmSync(tmpHome, { recursive: true, force: true });
      }
    };

    it('keeps authenticated UI bootstrap env intact without disabling bootstrap or spoofing VS Code host', async () => {
      const childProcess = require('child_process');
      const prevBootstrap = process.env.AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP;
      const prevVscode = process.env.ANTIGRAVITY_VSCODE_HOST;
      delete process.env.AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP;
      delete process.env.ANTIGRAVITY_VSCODE_HOST;

      let capturedEnv: Record<string, string> | undefined;
      const spawnSpy = jest
        .spyOn(childProcess, 'spawn')
        .mockImplementation((_exe: unknown, _args: unknown, opts: { env?: Record<string, string> }) => {
          capturedEnv = opts.env;
          return { on: jest.fn(), kill: jest.fn(), killed: false, exitCode: null };
        });
      const waitSpy = jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      try {
        await hubManager.startHub('/bin/agy', '/test/vault', 42500, 'env-profile');
        expect(capturedEnv?.AGY_ENABLE_HUB).toBe('1');
        expect(capturedEnv?.AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP).toBeUndefined();
        expect(capturedEnv?.ANTIGRAVITY_VSCODE_HOST).toBeUndefined();
      } finally {
        if (prevBootstrap !== undefined) process.env.AGY_REQUIRE_AUTHENTICATED_UI_BOOTSTRAP = prevBootstrap;
        if (prevVscode !== undefined) process.env.ANTIGRAVITY_VSCODE_HOST = prevVscode;
        waitSpy.mockRestore();
        spawnSpy.mockRestore();
      }
    });

    it('mints #t= from daemon/hub_<port>.json + POST /auth/mint, refreshes single-use tokens, and handles stop races', async () => {
      let mintCalls = 0;
      let holdNextMint = false;
      let releaseMint: () => void = () => {};
      let mintInFlight = false;
      const receivedCsrf: Array<string | undefined> = [];

      await withMockMintHub(
        44556,
        (req, res) => {
          if (req.method === 'POST' && req.url === '/auth/mint') {
            const csrf = req.headers['x-codeium-csrf-token'];
            receivedCsrf.push(typeof csrf === 'string' ? csrf : undefined);
            const respond = () => {
              if (csrf === 'valid-daemon-csrf') {
                mintCalls += 1;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ bootstrapToken: `minted-boot-tok-${mintCalls}` }));
              } else {
                res.writeHead(401);
                res.end('Unauthorized');
              }
            };
            if (holdNextMint) {
              mintInFlight = true;
              releaseMint = respond;
            } else {
              respond();
            }
            return;
          }
          res.writeHead(200);
          res.end('ok');
        },
        async ({ manager, port, writeDiscovery }) => {
          // Stale discovery file with wrong PID must be ignored until matching PID appears
          writeDiscovery('win-hub-profile', { pid: 99999, httpPort: port, csrfToken: 'stale-csrf' });

          const startPromise = manager.startHub('/bin/agy', '/test/vault', port, 'win-hub-profile');
          setTimeout(() => {
            writeDiscovery('win-hub-profile', { pid: 44556, httpPort: port, csrfToken: 'valid-daemon-csrf' });
          }, 50);

          expect(await startPromise).toContain('#t=minted-boot-tok-1');
          expect(receivedCsrf).toEqual(['valid-daemon-csrf']);

          // External browser mints a fresh token without clobbering startup bootstrapToken
          const browserUrl = await manager.getAuthenticatedHubUrl({ hostTheme: 'dark' });
          expect(browserUrl).toContain('hostTheme=dark');
          expect(browserUrl).toContain('#t=minted-boot-tok-2');
          expect(manager.getHubUrl()).toContain('#t=minted-boot-tok-1');

          // Stopping while /auth/mint is in flight must return '' (never port=null)
          holdNextMint = true;
          const racePromise = manager.getAuthenticatedHubUrl({ hostTheme: 'dark' });
          while (!mintInFlight) {
            await new Promise((r) => setImmediate(r));
          }
          manager.stopHub();
          releaseMint();
          expect(await racePromise).toBe('');
          expect(await manager.getAuthenticatedHubUrl()).toBe('');
        },
      );
    });

    it('stops discovery polling on 404 from /auth/mint and does not overwrite a winning stdout token', async () => {
      let mintHits = 0;
      await withMockMintHub(
        55667,
        (req, res) => {
          if (req.url === '/auth/mint') {
            mintHits += 1;
            res.writeHead(404);
            res.end('Not Found');
            return;
          }
          res.writeHead(200);
          res.end('ok');
        },
        async ({ manager, port, writeDiscovery }) => {
          writeDiscovery('legacy-win-profile', { pid: 55667, httpPort: port, csrfToken: 'legacy-csrf' });
          const url = await manager.startHub('/bin/agy', '/test/vault', port, 'legacy-win-profile');
          expect(url).not.toContain('#t=');
          expect(mintHits).toBe(1);
        },
      );

      // Late /auth/mint must not overwrite a token already captured from stdout
      let releaseMint: () => void = () => {};
      let mintStarted = false;
      await withMockMintHub(
        77889,
        (req, res) => {
          if (req.url === '/auth/mint') {
            mintStarted = true;
            releaseMint = () => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ bootstrapToken: 'late-minted-tok' }));
            };
            return;
          }
          res.writeHead(200);
          res.end('ok');
        },
        async ({ manager, port, stdout, writeDiscovery }) => {
          writeDiscovery('stdout-win-profile', { pid: 77889, httpPort: port, csrfToken: 'stdout-csrf' });
          const startPromise = manager.startHub('/bin/agy', '/test/vault', port, 'stdout-win-profile');
          while (!mintStarted) {
            await new Promise((r) => setImmediate(r));
          }
          stdout.emit('data', Buffer.from(`http://127.0.0.1:${port}/#t=stdout-winning-tok\n`));
          expect(await startPromise).toContain('#t=stdout-winning-tok');
          releaseMint();
          await new Promise((r) => setTimeout(r, 30));
          expect(manager.getHubUrl()).toContain('#t=stdout-winning-tok');
        },
      );
    });

    it('caps /auth/mint retries when the daemon keeps rejecting the token', async () => {
      let mintHits = 0;
      await withMockMintHub(
        66778,
        (req, res) => {
          if (req.url === '/auth/mint') {
            mintHits += 1;
            res.writeHead(401);
            res.end('Unauthorized');
            return;
          }
          res.writeHead(200);
          res.end('ok');
        },
        async ({ manager, port, writeDiscovery }) => {
          writeDiscovery('reject-win-profile', { pid: 66778, httpPort: port, csrfToken: 'rejected-csrf' });
          const startedAt = Date.now();
          const url = await manager.startHub('/bin/agy', '/test/vault', port, 'reject-win-profile');

          // A rejected token stays rejected: no request storm, no token in the URL.
          expect(mintHits).toBe(3);
          expect(url).not.toContain('#t=');
          // Minting stops, but the platform keeps waiting out the stdout budget
          // so a `#t=` that arrives late on stdout is still captured.
          expect(Date.now() - startedAt).toBeLessThan(1500);
        },
      );
    });

    it('converges after the stdout budget when the CLI never creates the discovery directory', async () => {
      const origPlatform = process.platform;
      try {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        await withMockMintHub(
          77890,
          (_req, res) => {
            res.writeHead(200);
            res.end('ok');
          },
          async ({ manager, port }) => {
            // No discovery file is ever written: a pre-discovery CLI build on Windows.
            const startedAt = Date.now();
            const url = await manager.startHub('/bin/agy', '/test/vault', port, 'legacy-no-discovery');
            const elapsed = Date.now() - startedAt;

            expect(url).not.toContain('#t=');
            // Must not burn the full 3s Windows budget on a token that cannot arrive.
            expect(elapsed).toBeGreaterThanOrEqual(900);
            expect(elapsed).toBeLessThan(2000);
          },
        );
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });

    it('exits waitForBootstrapToken promptly on cancellation regardless of platform', async () => {
      const origPlatform = process.platform;
      const fakeChild = { on: jest.fn(), off: jest.fn(), killed: false, exitCode: null } as any;
      let cancelled = false;
      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        const start = Date.now();
        await (hubManager as any).waitForBootstrapToken(
          fakeChild,
          () => null,
          jest.fn(),
          5000,
          async () => {
            cancelled = true;
            return true;
          },
          () => cancelled,
        );
        expect(Date.now() - start).toBeLessThan(500);
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
      }
    });
  });

  describe('cleanupStaleHubs', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cleanup-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('terminates verified stale tracked PID and orphan discovered PIDs without duplicate signals', async () => {
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const terminateSpy = jest.spyOn(AgyProcess, 'terminatePid').mockResolvedValue(true);
      const findSpy = jest.spyOn(AgyProcess, 'findAgyHubProcesses').mockReturnValue([7777, 8888, 9999]);

      const meta = {
        pid: 7777,
        port: 40000,
        profile: 'test-profile',
        vaultPath: '/test/vault',
        dangerouslySkipPermissions: false,
        startedAt: Date.now(),
      };
      saveHubInstanceMetadata('test-profile', meta, tmpDir);

      await hubManager.cleanupStaleHubs('test-profile', tmpDir);

      expect(terminateSpy).toHaveBeenCalledTimes(3);
      expect(terminateSpy).toHaveBeenCalledWith(7777, true);
      expect(terminateSpy).toHaveBeenCalledWith(8888, true);
      expect(terminateSpy).toHaveBeenCalledWith(9999, true);
      expect(loadHubInstanceMetadata('test-profile', tmpDir)).toBeNull();

      terminateSpy.mockRestore();
      findSpy.mockRestore();
    });

    it('skips signalling an unverified/recycled tracked PID on POSIX while removing stale metadata', async () => {
      const origPlatform = process.platform;
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const terminateSpy = jest.spyOn(AgyProcess, 'terminatePid').mockResolvedValue(true);
      const findSpy = jest.spyOn(AgyProcess, 'findAgyHubProcesses').mockReturnValue([8888]);

      try {
        Object.defineProperty(process, 'platform', { value: 'linux' });
        saveHubInstanceMetadata(
          'test-profile',
          {
            pid: 7777, // Recycled PID belonging to an unrelated process
            port: 40000,
            profile: 'test-profile',
            vaultPath: '/test/vault',
            dangerouslySkipPermissions: false,
            startedAt: Date.now() - 86400000,
          },
          tmpDir,
        );

        await hubManager.cleanupStaleHubs('test-profile', tmpDir);

        expect(terminateSpy).not.toHaveBeenCalledWith(7777, true);
        expect(terminateSpy).toHaveBeenCalledWith(8888, true);
        expect(loadHubInstanceMetadata('test-profile', tmpDir)).toBeNull();
      } finally {
        Object.defineProperty(process, 'platform', { value: origPlatform });
        terminateSpy.mockRestore();
        findSpy.mockRestore();
      }
    });

    it('serializes cleanupStaleHubs with startHub so cleanup cannot kill a newly spawned hub', async () => {
      const childProcess = require('child_process');
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const events: string[] = [];

      let releaseTerminate: () => void = () => {};
      const terminateGate = new Promise<boolean>((resolve) => {
        releaseTerminate = () => resolve(true);
      });

      const findSpy = jest
        .spyOn(AgyProcess, 'findAgyHubProcesses')
        .mockReturnValueOnce([6666])
        .mockReturnValue([]);
      const terminateSpy = jest.spyOn(AgyProcess, 'terminatePid').mockImplementation(async (pid: unknown) => {
        events.push(`terminate:${String(pid)}`);
        await terminateGate;
        events.push(`terminate-done:${String(pid)}`);
        return true;
      });
      const spawnSpy = jest.spyOn(childProcess, 'spawn').mockImplementation(() => {
        events.push('spawn');
        return {
          pid: 7788,
          on: jest.fn(),
          kill: jest.fn(),
          killed: false,
          exitCode: null,
        } as any;
      });
      jest.spyOn(hubManager as any, 'waitForPort').mockResolvedValue(undefined);

      const cleanupPromise = hubManager.cleanupStaleHubs('race-profile', tmpDir);
      const startPromise = hubManager.startHub('/bin/agy', '/test/vault', 42520, 'race-profile');

      // Yield so cleanup enters terminatePid; startHub must still be waiting on startMutex
      await Promise.resolve();
      await Promise.resolve();
      expect(spawnSpy).not.toHaveBeenCalled();

      releaseTerminate();
      await Promise.all([cleanupPromise, startPromise]);

      expect(events).toEqual(['terminate:6666', 'terminate-done:6666', 'spawn']);
      expect(terminateSpy).not.toHaveBeenCalledWith(7788, true);

      findSpy.mockRestore();
      terminateSpy.mockRestore();
      spawnSpy.mockRestore();
    });

    it('does not terminate the currently managed child PID', async () => {
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const terminateSpy = jest.spyOn(AgyProcess, 'terminatePid').mockResolvedValue(true);
      const findSpy = jest.spyOn(AgyProcess, 'findAgyHubProcesses').mockReturnValue([1234, 5678]);

      (hubManager as any).hubProcess = { pid: 1234 };
      (hubManager as any).spawningProcess = { child: { pid: 5678 }, profile: 'test-profile' };

      await hubManager.cleanupStaleHubs('test-profile', tmpDir);

      expect(terminateSpy).not.toHaveBeenCalled();

      terminateSpy.mockRestore();
      findSpy.mockRestore();
    });
  });
});


