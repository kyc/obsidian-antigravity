import { Menu, Plugin } from 'obsidian';
import { t } from '../i18n';
import { ProcessState } from '../types';

export class StatusBarItem {
  private element: HTMLElement;
  private spinnerEl: HTMLElement;
  private textEl: HTMLElement;
  private currentState: ProcessState = 'idle';
  private currentMessage = t('statusBar.idle');

  constructor(
    plugin: Plugin,
    statusBarEl: HTMLElement,
    private onCancelTask?: () => void,
    private onOpenHub?: () => void,
  ) {
    this.element = statusBarEl.createDiv({
      cls: 'antigravity-status-bar-item',
    });

    this.spinnerEl = this.element.createSpan({
      cls: 'antigravity-status-spinner',
    });
    this.spinnerEl.hide();

    this.textEl = this.element.createSpan({
      text: 'Antigravity',
    });

    plugin.registerDomEvent(this.element, 'click', (evt: MouseEvent) => {
      this.showMenu(evt);
    });
  }

  update(state: ProcessState, text?: string): void {
    this.currentState = state;
    this.currentMessage =
      text || (state === 'idle' ? t('statusBar.idle') : state === 'running' ? t('statusBar.working') : t('statusBar.error'));

    if (state === 'running') {
      this.spinnerEl.show();
      this.textEl.setText(`Antigravity: ${this.currentMessage}`);
      this.element.title = t('statusBar.tooltipWorking');
    } else if (state === 'error') {
      this.spinnerEl.hide();
      this.textEl.setText(`Antigravity: ${this.currentMessage}`);
      this.element.title = t('statusBar.tooltipError');
    } else {
      this.spinnerEl.hide();
      this.textEl.setText('Antigravity');
      this.element.title = t('statusBar.tooltipReady');
    }
  }

  private showMenu(evt: MouseEvent): void {
    const menu = new Menu();

    if (this.currentState === 'running') {
      menu.addItem((item) => {
        item
          .setTitle(t('statusBar.menuStopTask'))
          .setIcon('cross')
          .onClick(() => {
            this.onCancelTask?.();
          });
      });
    }

    menu.addItem((item) => {
      item
        .setTitle(t('statusBar.menuOpenHub'))
        .setIcon('layout-sidebar')
        .onClick(() => {
          this.onOpenHub?.();
        });
    });

    menu.showAtMouseEvent(evt);
  }
}
