import { EventEmitter } from 'events';
import { AgyProcess } from '../../../src/core/AgyProcess';
import { VaultContext } from '../../../src/core/VaultContext';
import { VaultTaskRunner } from '../../../src/core/VaultTaskRunner';

describe('VaultTaskRunner', () => {
  let mockApp: any;
  let mockVaultContext: jest.Mocked<VaultContext>;
  let mockSettings: any;
  let runner: VaultTaskRunner;

  beforeEach(() => {
    mockApp = {};
    mockVaultContext = {
      getVaultBasePath: jest.fn().mockReturnValue('/home/user/vault'),
      ensureVaultRules: jest.fn(),
      formatPromptWithContext: jest.fn().mockImplementation((prompt) => `Context: ${prompt}`),
    } as any;
    mockSettings = {
      enableVaultRules: false,
      model: 'gemini-3.8-flash-high',
      effort: 'none',
      hubProfile: 'antigravity-obsidian',
      customRulesPath: 'AGENTS.md',
      allowUnrestrictedTasks: false,
      unrestrictedConfirmed: false,
    };
    runner = new VaultTaskRunner(mockVaultContext, () => mockSettings);
  });

  afterEach(() => {
    runner.dispose();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('spawns agy in --print mode with approval mode by default (no permission bypass)', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const spawnArgs = spawnSpy.mock.calls[0][0].args;
    expect(spawnArgs).toContain('--print');
    expect(spawnArgs).toContain('Context: Summarize note');
    expect(spawnArgs).toContain('--output-format');
    expect(spawnArgs).toContain('stream-json');
    expect(spawnArgs).not.toContain('--dangerously-skip-permissions');
    expect(spawnArgs).toContain('--app_data_dir=antigravity-obsidian');

    // Simulate stdout stream
    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'step_update',
          step_update: { step_type: 'agent_response', text_delta: 'Hello world' },
        }) + '\n',
      ),
    );

    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: 'Hello world' },
        }) + '\n',
      ),
    );

    fakeChild.emit('exit', 0);

    const result = await runPromise;
    expect(result).toBe('Hello world');
  });

  it('includes --dangerously-skip-permissions when allowUnrestrictedTasks is enabled', async () => {
    mockSettings.allowUnrestrictedTasks = true;
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    const spawnArgs = spawnSpy.mock.calls[0][0].args;
    expect(spawnArgs).toContain('--dangerously-skip-permissions');

    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: 'Done unrestricted' },
        }) + '\n',
      ),
    );
    fakeChild.emit('exit', 0);

    const result = await runPromise;
    expect(result).toBe('Done unrestricted');
  });

  it('appends warning note when denied_actions are returned in stream result', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Run command',
      context: { scope: 'vault' },
    });

    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'SUCCESS',
            response: 'Completed read-only parts',
            denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
          },
        }) + '\n',
      ),
    );
    fakeChild.emit('exit', 0);

    const result = await runPromise;
    expect(result).toContain('Completed read-only parts');
    expect(result).toContain('Restricted Execution: Certain tool permissions were denied (RunCommand)');
  });

  it('rejects with error when result has status ERROR', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Failing prompt',
      context: { scope: 'vault' },
    });

    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: { status: 'ERROR', error: 'Model quota exceeded' },
        }) + '\n',
      ),
    );

    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow('Model quota exceeded');
  });

  it('cancels active task on abort()', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);
    const killSpy = jest.spyOn(AgyProcess, 'killProcess').mockImplementation(() => {});

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Long running task',
      context: { scope: 'vault' },
    });

    expect(runner.running).toBe(true);

    runner.abort();

    expect(killSpy).toHaveBeenCalledWith(fakeChild);

    fakeChild.emit('exit', null);

    await expect(runPromise).rejects.toThrow('Antigravity task was cancelled.');
    expect(runner.running).toBe(false);
  });

  it('does not let late exit of aborted task 1 corrupt subsequently started task 2', async () => {
    const fakeChild1: any = new EventEmitter();
    fakeChild1.stdin = { write: jest.fn(), end: jest.fn() };
    fakeChild1.stdout = new EventEmitter();
    fakeChild1.stderr = new EventEmitter();

    const fakeChild2: any = new EventEmitter();
    fakeChild2.stdin = { write: jest.fn(), end: jest.fn() };
    fakeChild2.stdout = new EventEmitter();
    fakeChild2.stderr = new EventEmitter();

    const statusUpdates: Array<{ state: string; text?: string }> = [];
    runner.dispose();
    runner = new VaultTaskRunner(
      mockVaultContext,
      () => mockSettings,
      (state, text) => {
        statusUpdates.push({ state, text });
      },
    );

    jest.spyOn(AgyProcess, 'killProcess').mockImplementation(() => {});
    jest
      .spyOn(AgyProcess, 'spawnProcess')
      .mockReturnValueOnce(fakeChild1)
      .mockReturnValueOnce(fakeChild2);

    // 1. Start Task 1
    const run1Promise = runner.runTask('/bin/agy', {
      prompt: 'Task 1',
      context: { scope: 'vault' },
    });
    expect(runner.running).toBe(true);

    // 2. Abort Task 1
    runner.abort();
    expect(runner.running).toBe(false);
    await expect(run1Promise).rejects.toThrow('Antigravity task was cancelled.');

    // 3. Start Task 2 immediately before fakeChild1 emits 'exit'
    const run2Promise = runner.runTask('/bin/agy', {
      prompt: 'Task 2',
      context: { scope: 'vault' },
    });
    expect(runner.running).toBe(true);

    const statusCountBeforeLateExit = statusUpdates.length;

    // 4. Stale/delayed exit event arrives from killed Task 1
    fakeChild1.emit('exit', null);

    // 5. Assert Task 2 is NOT polluted: running must still be true!
    expect(runner.running).toBe(true);

    // Assert statusUpdates did not receive an error or idle from Task 1's late exit
    expect(statusUpdates.length).toBe(statusCountBeforeLateExit);

    // 6. Complete Task 2
    fakeChild2.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: 'Task 2 finished' },
        }) + '\n',
      ),
    );
    fakeChild2.emit('exit', 0);

    const task2Result = await run2Promise;
    expect(task2Result).toBe('Task 2 finished');
    expect(runner.running).toBe(false);
  });
});
