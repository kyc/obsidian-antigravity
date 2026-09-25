import { EventEmitter } from 'events';
import { Notice } from 'obsidian';
import { AgyProcess } from '../../../src/core/AgyProcess';
import { VaultContext } from '../../../src/core/VaultContext';
import { TaskCancelledError, VaultTaskRunner } from '../../../src/core/VaultTaskRunner';

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

  it('identifies a model that conflicts with an explicit effort setting', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    // The real CLI line, including the generic "invalid model selection" prefix
    // that must not shadow the more specific conflict hint.
    fakeChild.stderr.emit(
      'data',
      Buffer.from(
        'E printmode.go:266] Print mode: invalid model selection (--model "gemini-3.8-flash-high" --effort "medium"): --model gemini-3.8-flash-high conflicts with --effort=medium\n',
      ),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow(/already includes a reasoning level/i);
  });

  it('identifies a model that requires an explicit effort setting', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit(
      'data',
      Buffer.from('--model gemini-3.8-flash requires --effort (available: low, medium, high)\n'),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow(/-high\/-medium\/-low suffix/i);
  });

  it('delivers the answer when the CLI reports an error after producing output', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    // Mirrors a real run: the agent finished its work, then a transient 503
    // during teardown flipped the status to ERROR. The answer must survive.
    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: {
            status: 'ERROR',
            response: '当前打开的笔记是：图工程',
            error: 'API error (attempt 1): UNAVAILABLE (code 503)',
          },
        }) + '\n',
      ),
    );
    fakeChild.emit('exit', 1);

    const output = await runPromise;
    expect(output).toContain('当前打开的笔记是：图工程');
    expect(output).toContain('[!WARNING]');
    expect(output).toContain('503');
  });

  it('still rejects when an error produced no output at all', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: { status: 'ERROR', error: 'Antigravity execution failed' },
        }) + '\n',
      ),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow(/execution failed/i);
  });

  it('raises no toast for tool progress, even across many invocations', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);
    (Notice as unknown as jest.Mock).mockClear();

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    // Interleave ACTIVE/DONE pairs well past the old 4s throttle window.
    for (let i = 0; i < 12; i += 1) {
      for (const state of ['ACTIVE', 'DONE']) {
        fakeChild.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              event: 'step_update',
              step_update: { step_type: 'tool', state, tool_name: 'mcp_tool' },
            }) + '\n',
          ),
        );
      }
    }

    fakeChild.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          event: 'result',
          result: { status: 'SUCCESS', response: 'done' },
        }) + '\n',
      ),
    );
    fakeChild.emit('exit', 0);

    await runPromise;

    // Only the single completion notice should have fired.
    const messages = (Notice as unknown as jest.Mock).mock.calls.map((call) => call[0]);
    expect(messages.some((m: string) => m.includes('mcp_tool'))).toBe(false);
  });

  it('reports the missing-model cause instead of only the exit code', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit(
      'data',
      Buffer.from('I0916 21:47:17.475190 1 resolver.go:85] Model ID gemini-9.9 not in local config\n'),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow(/agy models/);
  });

  it('reports expired credentials rather than a model error', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit(
      'data',
      Buffer.from('E0916 errorreport.go:224] error getting token source: You are not logged into Antigravity.\n'),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow(/not authenticated/i);
  });

  // The generic wrapper appears at W level during healthy startup (measured on
  // a real machine: 452 W vs 488 E lines), so it must not, on its own, be read
  // as "you are logged out" — that would send users to re-authenticate when the
  // actual failure was something else entirely.
  // The filter keys off the log shape, not a literal "I0"/"W0" prefix, so it
  // must keep working once the month rolls past September and the stamp becomes
  // e.g. I1016. A prefix match silently stopped filtering there.
  it('filters informational noise in double-digit months', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit(
      'data',
      // The noise line must come last: the reporter keeps only the final
      // surviving line, so a trailing informational line is what a prefix-based
      // filter would wrongly surface to the user.
      Buffer.from('real failure detail\nI1016 12:00:00.000000    42 setup.go:10] starting up\n'),
    );
    fakeChild.emit('exit', 1);

    const err = await runPromise.catch((e: Error) => e.message);
    expect(err).toContain('real failure detail');
    expect(err).not.toContain('starting up');
  });

  it('does not blame authentication for the generic token-source warning', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit(
      'data',
      Buffer.from('W0916 errorreport.go:224] failed to poll ListExperiments: error getting token source\n'),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.not.toThrow(/not authenticated/i);
  });

  it('reports a read-only profile directory as its own cause', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit(
      'data',
      Buffer.from('E reading log file: read-only file system\n'),
    );
    fakeChild.emit('exit', 1);

    await expect(runPromise).rejects.toThrow(/read-only/i);
  });

  it('falls back to the last meaningful stderr line for unknown failures', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    fakeChild.stderr.emit('data', Buffer.from('I0916 noise line one\n'));
    fakeChild.stderr.emit('data', Buffer.from('something specific broke\n'));
    fakeChild.emit('exit', 3);

    await expect(runPromise).rejects.toThrow(/something specific broke/);
  });

  it('omits --dangerously-skip-permissions when unrestricted mode is enabled but not confirmed', async () => {
    mockSettings.allowUnrestrictedTasks = true;
    mockSettings.unrestrictedConfirmed = false;
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    const spawnSpy = jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Summarize note',
      context: { scope: 'vault' },
    });

    expect(spawnSpy.mock.calls[0][0].args).not.toContain('--dangerously-skip-permissions');
    fakeChild.emit('exit', 0);
    await runPromise;
  });

  it('parses a final result line that has no trailing newline and emits done', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);

    const events: string[] = [];
    const runPromise = runner.runTask(
      '/bin/agy',
      { prompt: 'Summarize note', context: { scope: 'vault' } },
      (evt) => events.push(evt.type),
    );

    fakeChild.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Tail' } })),
    );
    fakeChild.emit('exit', 0);

    await expect(runPromise).resolves.toBe('Tail');
    expect(events).toContain('done');
  });

  it('includes --dangerously-skip-permissions when unrestricted mode is enabled and confirmed', async () => {
    mockSettings.allowUnrestrictedTasks = true;
    mockSettings.unrestrictedConfirmed = true;
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

    await expect(runPromise).rejects.toThrow(TaskCancelledError);
    expect(runner.running).toBe(false);
  });

  it('suppresses cancellation notice when abort(false) is called', async () => {
    const fakeChild: any = new EventEmitter();
    fakeChild.stdin = { write: jest.fn(), end: jest.fn() };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();

    jest.spyOn(AgyProcess, 'spawnProcess').mockReturnValue(fakeChild);
    jest.spyOn(AgyProcess, 'killProcess').mockImplementation(() => {});

    const runPromise = runner.runTask('/bin/agy', {
      prompt: 'Task to abort silently',
      context: { scope: 'vault' },
    });

    (Notice as unknown as jest.Mock).mockClear();
    runner.abort(false);

    await expect(runPromise).rejects.toThrow(TaskCancelledError);
    expect(Notice).not.toHaveBeenCalled();
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
