import { ChildProcess } from 'child_process';
import { Notice } from 'obsidian';
import { AgyProcess } from './AgyProcess';
import { VaultContext } from './VaultContext';
import { t } from '../i18n';
import { AntigravityPluginSettings, StreamEvent, TaskExecutionOptions } from '../types';

export interface TaskProgressEvent {
  type: 'status' | 'tool' | 'text' | 'done' | 'error';
  message: string;
}

export class TaskCancelledError extends Error {
  constructor(message?: string) {
    super(message ?? t('notices.taskCancelledError'));
    this.name = 'TaskCancelledError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface ActiveTaskRun {
  runId: number;
  child: ChildProcess;
  isAborted: boolean;
  isSettled: boolean;
  reject: (err: Error) => void;
  resolve: (result: string) => void;
}

/** How long an error state stays visible before reverting to idle. */
const ERROR_STATE_RESET_MS = 6000;

/** How much of the process's stderr tail to retain for failure reporting. */
const STDERR_TAIL_LIMIT = 4000;

/**
 * Signatures of CLI startup failures that surface as a bare exit code. Without
 * this mapping the user sees something like "model selection error" for what is
 * actually an expired credential, or a filesystem problem.
 */
const CLI_FAILURE_HINTS: Array<{ pattern: RegExp; key: string }> = [
  // The CLI treats the model's -high/-medium/-low suffix as the reasoning
  // level, and rejects any pairing of it with an explicit --effort.
  { pattern: /conflicts with --effort/i, key: 'errors.modelEffortConflict' },
  { pattern: /requires --effort/i, key: 'errors.modelNeedsEffort' },
  { pattern: /invalid model selection/i, key: 'errors.modelUnavailable' },
  { pattern: /not in local config/i, key: 'errors.modelUnavailable' },
  // Matched on the specific phrase rather than the generic
  // "error getting token source" wrapper: that wrapper also appears at W level
  // during otherwise healthy startup (measured here: 452 W vs 488 E lines), so
  // pairing it with an unrelated failure would send users to re-authenticate
  // for the wrong reason. The specific phrase only accompanies a real logout.
  { pattern: /not logged into antigravity/i, key: 'errors.notAuthenticated' },
  { pattern: /read-only file system/i, key: 'errors.readOnlyProfile' },
  { pattern: /unable to open database file/i, key: 'errors.profileUnwritable' },
];

export class VaultTaskRunner {
  private nextRunId = 0;
  private currentRun: ActiveTaskRun | null = null;
  private statusResetTimer: number | null = null;

  constructor(
    private vaultContext: VaultContext,
    private getSettings: () => AntigravityPluginSettings,
    private onStatusChange?: (state: 'idle' | 'running' | 'error', text?: string) => void,
  ) {}

  get running(): boolean {
    return this.currentRun !== null;
  }

  async runTask(
    executablePath: string,
    options: TaskExecutionOptions,
    onProgress?: (event: TaskProgressEvent) => void,
  ): Promise<string> {
    if (this.currentRun !== null) {
      throw new Error('Another Antigravity task is already running. Please wait or cancel it.');
    }

    const vaultPath = this.vaultContext.getVaultBasePath();
    if (!vaultPath) {
      throw new Error('Unable to determine vault base path.');
    }

    const settings = this.getSettings();

    // Ensure rules file exists if enabled
    if (settings.enableVaultRules) {
      this.vaultContext.ensureVaultRules(settings.customRulesPath);
    }

    const formattedPrompt = this.vaultContext.formatPromptWithContext(options.prompt, options.context);

    const model = options.model || settings.model || 'gemini-3.8-flash-high';

    const args: string[] = [
      '--print',
      formattedPrompt,
      '--output-format',
      'stream-json',
      '--add-dir',
      vaultPath,
    ];

    // Enforce the confirmation here too, not only in the UI flow, so no caller
    // can reach unrestricted mode without the user's explicit approval.
    if (settings.allowUnrestrictedTasks && settings.unrestrictedConfirmed) {
      args.push('--dangerously-skip-permissions');
    }

    const profile = settings.hubProfile || 'antigravity-obsidian';
    args.push(`--app_data_dir=${profile}`);

    if (model) {
      args.push('--model', model);
    }

    if (settings.defaultAgent) {
      args.push('--agent', settings.defaultAgent);
    }

    const runId = ++this.nextRunId;
    this.updateStatus('running', 'Initializing...');

    return new Promise<string>((resolve, reject) => {
      let accumulatedOutput = '';
      let stdoutBuffer = '';

      // Tool progress is surfaced through the status bar and the progress
      // callback only. A single task can invoke dozens of tools, so raising a
      // toast per call would bury the notices that actually matter (completion,
      // cancellation, failure).
      const notifyProgress = (event: TaskProgressEvent) => {
        if (this.currentRun?.runId !== runId) return;
        onProgress?.(event);
        if (event.type === 'tool' || event.type === 'status') {
          this.updateStatus('running', event.message);
        }
      };

      try {
        const child = AgyProcess.spawnProcess({
          executable: executablePath,
          args,
          cwd: vaultPath,
        });

        const runRecord: ActiveTaskRun = {
          runId,
          child,
          isAborted: false,
          isSettled: false,
          reject,
          resolve,
        };
        this.currentRun = runRecord;

        let terminalError: string | null = null;
        let resultResponse: string | null = null;
        let stderrTail = '';

        const processLine = (line: string): void => {
          const trimmed = line.trim();
          if (!trimmed) return;

          try {
            const event = JSON.parse(trimmed) as StreamEvent;
            if (event.event === 'result' && event.result) {
              if (event.result.status === 'ERROR') {
                terminalError = event.result.error || event.result.message || 'Antigravity execution failed';
              }
              if (typeof event.result.response === 'string') {
                resultResponse = event.result.response;
              }
              if (Array.isArray(event.result.denied_actions) && event.result.denied_actions.length > 0) {
                const deniedList = event.result.denied_actions
                  .map((d) => d.display_name || d.action)
                  .filter(Boolean)
                  .join(', ');
                const note = `\n\n> [!WARNING] Restricted Execution: Certain tool permissions were denied (${deniedList}). Enable "Allow Unrestricted Tasks" in settings if autonomous tool execution is needed.`;
                resultResponse = (resultResponse || '') + note;
              }
            }

            this.handleStreamEvent(event, (evt) => {
              if (evt.type === 'text') {
                accumulatedOutput += evt.message;
              }
              notifyProgress(evt);
            });
          } catch {
            // Raw non-JSON line
            accumulatedOutput += line + '\n';
          }
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          if (this.currentRun?.runId !== runId) return;
          stdoutBuffer += chunk.toString('utf8');
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            processLine(line);
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          if (this.currentRun?.runId !== runId) return;
          const stderrText = chunk.toString('utf8');
          // Retain a bounded tail so a failure can report the real cause rather
          // than only the exit code. The CLI emits a lot of startup noise, so
          // the last lines are the ones that matter.
          stderrTail = (stderrTail + stderrText).slice(-STDERR_TAIL_LIMIT);
          if (stderrText.toLowerCase().includes('error')) {
            notifyProgress({ type: 'status', message: stderrText.trim() });
          }
        });

        child.on('error', (err) => {
          if (runRecord.isSettled) return;
          runRecord.isSettled = true;

          const isCurrent = this.currentRun?.runId === runId;
          if (isCurrent) {
            this.currentRun = null;
            this.setErrorStatus(err.message);
          }
          reject(err);
        });

        child.on('exit', (code) => {
          if (runRecord.isSettled) return;
          runRecord.isSettled = true;

          // The final line (often the 'result' event) may lack a trailing newline.
          if (this.currentRun?.runId === runId && stdoutBuffer.trim()) {
            processLine(stdoutBuffer);
            stdoutBuffer = '';
          }

          const isCurrent = this.currentRun?.runId === runId;
          if (runRecord.isAborted) {
            if (isCurrent) {
              this.currentRun = null;
              this.updateStatus('idle', 'Task cancelled');
            }
            reject(new TaskCancelledError('Antigravity task was cancelled.'));
            return;
          }

          const partial = resultResponse ?? accumulatedOutput.trim();

          if (code === 0 && !terminalError) {
            if (isCurrent) {
              // notifyProgress drops events once currentRun is cleared, so emit first.
              notifyProgress({ type: 'done', message: t('notices.taskCompletedProgress') });
              this.currentRun = null;
              this.updateStatus('idle');
              new Notice(t('notices.taskCompleted'));
            }
            resolve(partial);
            return;
          }

          // The CLI can report a failure after the agent has already produced a
          // complete answer — a transient 503 during teardown is the common
          // case. Discarding that answer loses real work, so deliver it with a
          // warning instead, mirroring how denied_actions is surfaced above.
          if (partial) {
            if (isCurrent) {
              this.currentRun = null;
              this.updateStatus('idle');
              new Notice(t('notices.taskCompletedWithWarning'));
            }
            resolve(
              `${partial}\n\n> [!WARNING] ${t('resultModal.partialResultWarning', {
                detail: terminalError ?? t('notices.processExitError', { code: code ?? 'unknown' }),
              })}`,
            );
            return;
          }

          const errorMsg = terminalError
            ?? this.describeCliFailure(code, stderrTail, accumulatedOutput);
          if (isCurrent) {
            this.currentRun = null;
            this.setErrorStatus(errorMsg);
          }
          reject(new Error(errorMsg));
        });
      } catch (err) {
        if (this.currentRun?.runId === runId) {
          this.currentRun = null;
          this.setErrorStatus((err as Error).message);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  abort(showNotice: boolean = true): void {
    const run = this.currentRun;
    if (!run || run.isSettled) return;

    run.isAborted = true;
    run.isSettled = true;
    this.currentRun = null;

    AgyProcess.killProcess(run.child);
    this.updateStatus('idle', t('notices.taskCancelledStatus'));
    if (showNotice) {
      new Notice(t('notices.taskCancelled'));
    }

    run.reject(new TaskCancelledError(t('notices.taskCancelledError')));
  }

  /** Releases pending timers. Safe to call on plugin unload. */
  dispose(): void {
    this.clearStatusResetTimer();
  }

  private updateStatus(state: 'idle' | 'running' | 'error', text?: string): void {
    this.clearStatusResetTimer();
    this.onStatusChange?.(state, text);
  }

  /** Cancels any pending error-state reset. */
  private clearStatusResetTimer(): void {
    if (this.statusResetTimer !== null) {
      window.clearTimeout(this.statusResetTimer);
      this.statusResetTimer = null;
    }
  }

  /**
   * Transitions to the error state and schedules a revert to idle. The timer is
   * held so a later status change (e.g. a new run starting) cancels it rather
   * than letting a stale reset overwrite fresher state.
   */
  private setErrorStatus(message: string): void {
    this.updateStatus('error', message);
    this.statusResetTimer = window.setTimeout(() => {
      this.statusResetTimer = null;
      if (this.currentRun === null) {
        this.updateStatus('idle');
      }
    }, ERROR_STATE_RESET_MS);
  }

  /**
   * Turns a failed CLI exit into something the user can act on.
   *
   * The CLI writes a large amount of startup noise to stderr, and the genuine
   * cause is often a single line inside it. Reporting only the exit code makes
   * every distinct failure look identical, so this scans the captured output for
   * known signatures and falls back to the last meaningful stderr line.
   */
  private describeCliFailure(code: number | null, stderrTail: string, stdout: string): string {
    const haystack = `${stderrTail}\n${stdout}`;
    for (const hint of CLI_FAILURE_HINTS) {
      if (hint.pattern.test(haystack)) {
        return t(hint.key as Parameters<typeof t>[0]);
      }
    }

    const lastMeaningful = stderrTail
      .split('\n')
      .map((line) => line.trim())
      // Structured CLI logs are prefixed with a severity letter and a 4-digit
      // MMDD stamp (`I0916`, `E1201`). Matching a literal `I0`/`W0` prefix would
      // silently stop filtering noise from October onward, so match the shape
      // rather than one month range.
      .filter((line) => line.length > 0 && !/^[IW]\d{4}\s/.test(line))
      .pop();

    if (lastMeaningful) {
      return t('notices.processExitWithDetail', {
        code: code ?? 'unknown',
        detail: lastMeaningful.slice(0, 300),
      });
    }

    return t('notices.processExitError', { code: code ?? 'unknown' });
  }

  private handleStreamEvent(event: StreamEvent, emit: (event: TaskProgressEvent) => void): void {
    if (!event || typeof event !== 'object') return;

    // Antigravity native protocol
    if (event.event === 'step_update' && event.step_update) {
      const update = event.step_update;
      if (update.step_type === 'agent_response' && typeof update.text_delta === 'string') {
        emit({ type: 'text', message: update.text_delta });
        return;
      }
      if (update.step_type === 'tool') {
        const toolInfo = update.tool_info;
        const toolName = update.tool_name || toolInfo?.name || 'tool';
        const actionDesc = update.state === 'DONE' ? `Finished ${toolName}` : `Running ${toolName}`;
        emit({ type: 'tool', message: `[${toolName}] ${actionDesc}` });
        return;
      }
    }
  }
}
