import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Notice } from 'obsidian';
import { AgyHubManager } from '../../../src/core/AgyHubManager';
import { loadHubInstanceMetadata, saveHubInstanceMetadata } from '../../../src/core/AgyProfile';

describe('AgyHubManager', () => {
  let hubManager: AgyHubManager;

  beforeEach(() => {
    hubManager = new AgyHubManager();
  });

  afterEach(() => {
    hubManager.stopHub();
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
  });

  describe('cleanupStaleHubs', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cleanup-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('terminates stale tracked PID and orphan discovered PIDs', async () => {
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const terminateSpy = jest.spyOn(AgyProcess, 'terminatePid').mockResolvedValue(true);
      const findSpy = jest.spyOn(AgyProcess, 'findAgyHubProcesses').mockReturnValue([8888, 9999]);

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

      expect(terminateSpy).toHaveBeenCalledWith(7777, true);
      expect(terminateSpy).toHaveBeenCalledWith(8888, true);
      expect(terminateSpy).toHaveBeenCalledWith(9999, true);
      expect(loadHubInstanceMetadata('test-profile', tmpDir)).toBeNull();

      terminateSpy.mockRestore();
      findSpy.mockRestore();
    });

    it('does not terminate the currently managed child PID', async () => {
      const { AgyProcess } = require('../../../src/core/AgyProcess');
      const terminateSpy = jest.spyOn(AgyProcess, 'terminatePid').mockResolvedValue(true);
      const findSpy = jest.spyOn(AgyProcess, 'findAgyHubProcesses').mockReturnValue([1234]);

      (hubManager as any).hubProcess = { pid: 1234 };

      await hubManager.cleanupStaleHubs('test-profile', tmpDir);

      expect(terminateSpy).not.toHaveBeenCalled();

      terminateSpy.mockRestore();
      findSpy.mockRestore();
    });
  });
});


