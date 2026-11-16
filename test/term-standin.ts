/**
 * A terminal that is only objects: a keyboard a test types on, a screen that keeps what was
 * written to it, and a process that only notes how it was told to end. With them the real
 * terminal layer, and the interface on it, run in a test with no terminal at all.
 */

import { EventEmitter } from 'node:events';

/** A keyboard nobody is at: a test types on it. */
export class Keyboard extends EventEmitter {
  raw = false;
  paused = true;
  setRawMode(on: boolean): void {
    this.raw = on;
  }
  setEncoding(): void {}
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  type(text: string): void {
    this.emit('data', text);
  }
}

/** A screen nobody looks at: everything written to it is kept. */
export class Screen extends EventEmitter {
  columns: number;
  rows: number;
  written = '';
  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }
  write(text: string): boolean {
    this.written += text;
    return true;
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

/** A process that only notes how it was told to end, so the test's own process is left alone. */
export class Process extends EventEmitter {
  exited: number | undefined;
  exit(code?: number): void {
    this.exited ??= code ?? 0;
  }
}
