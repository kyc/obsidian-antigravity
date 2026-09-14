import { ChildProcess } from 'child_process';
import { App, Notice } from 'obsidian';
import { AgyProcess } from './AgyProcess';
import { VaultContext } from './VaultContext';
import { t } from '../i18n';
import { AntigravityPluginSettings, StreamEvent, TaskExecutionOptions } from '../types';

export interface TaskProgressEvent {
  type: 'status' | 'tool' | 'text' | 'done' | 'error';
  message: string;
}

interface ActiveTaskRun {
  runId: number;
  child: ChildProcess;
  isAborted: boolean;
  isSettled: boolean;
  reject: (err: Error) => void;
  resolve: (result: string) => void;
}

export class VaultTaskRunner {
  private nextRunId = 0;
  private currentRun: ActiveTaskRun | null = null;

  constructor(
    private _app: App,
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
    const effort = options.effort || settings.effort || 'none';

    const args: string[] = [
      '--print',
      formattedPrompt,
      '--output-format',
      'stream-json',
      '--add-dir',
      vaultPath,
    ];

    if (settings.allowUnrestrictedTasks) {
      args.push('--dangerously-skip-permissions');
    }

    const profile = settings.hubProfile || 'antigravity-obsidian';
    args.push(`--app_data_dir=${profile}`);

    if (model) {
      args.push('--model', model);
    }

    if (effort && effort !== 'none') {
      args.push('--effort', effort);
    }

    if (settings.defaultAgent) {
      args.push('--agent', settings.defaultAgent);
    }

    const runId = ++this.nextRunId;
    this.updateStatus('running', 'Initializing...');

    return new Promise<string>((resolve, reject) => {
      let accumulatedOutput = '';
      let stdoutBuffer = '';
      let lastNoticeTime = 0;

      const notifyProgress = (event: TaskProgressEvent) => {
        if (this.currentRun?.runId !== runId) return;
        onProgress?.(event);
        if (event.type === 'tool' || event.type === 'status') {
          this.updateStatus('running', event.message);
          const now = Date.now();
          if (now - lastNoticeTime > 4000) {
            new Notice(`[Antigravity] ${event.message}`);
            lastNoticeTime = now;
          }
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

        child.stdout?.on('data', (chunk: Buffer) => {
          if (this.currentRun?.runId !== runId) return;
          stdoutBuffer += chunk.toString('utf8');
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

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
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          if (this.currentRun?.runId !== runId) return;
          const stderrText = chunk.toString('utf8');
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
            this.updateStatus('error', err.message);
            window.setTimeout(() => {
              if (this.currentRun === null) {
                this.updateStatus('idle');
              }
            }, 6000);
          }
          reject(err);
        });

        child.on('exit', (code) => {
          if (runRecord.isSettled) return;
          runRecord.isSettled = true;

          const isCurrent = this.currentRun?.runId === runId;
          if (runRecord.isAborted) {
            if (isCurrent) {
              this.currentRun = null;
              this.updateStatus('idle', 'Task cancelled');
            }
            reject(new Error('Antigravity task was cancelled.'));
            return;
          }

          if (code === 0 && !terminalError) {
            if (isCurrent) {
              this.currentRun = null;
              this.updateStatus('idle');
              notifyProgress({ type: 'done', message: t('notices.taskCompletedProgress') });
              new Notice(t('notices.taskCompleted'));
            }
            resolve(resultResponse ?? accumulatedOutput.trim());
          } else {
            const errorMsg = terminalError || t('notices.processExitError', { code });
            if (isCurrent) {
              this.currentRun = null;
              this.updateStatus('error', errorMsg);
              window.setTimeout(() => {
                if (this.currentRun === null) {
                  this.updateStatus('idle');
                }
              }, 6000);
            }
            reject(new Error(errorMsg));
          }
        });
      } catch (err) {
        if (this.currentRun?.runId === runId) {
          this.currentRun = null;
          this.updateStatus('error', (err as Error).message);
          window.setTimeout(() => {
            if (this.currentRun === null) {
              this.updateStatus('idle');
            }
          }, 6000);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  abort(): void {
    const run = this.currentRun;
    if (!run || run.isSettled) return;

    run.isAborted = true;
    run.isSettled = true;
    this.currentRun = null;

    AgyProcess.killProcess(run.child);
    this.updateStatus('idle', t('notices.taskCancelledStatus'));
    new Notice(t('notices.taskCancelled'));

    run.reject(new Error(t('notices.taskCancelledError')));
  }

  private updateStatus(state: 'idle' | 'running' | 'error', text?: string): void {
    this.onStatusChange?.(state, text);
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
