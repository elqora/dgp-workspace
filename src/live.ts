// SPDX-License-Identifier: GPL-3.0-only

import type { WorkspaceLiveAdapter, WorkspaceLiveEvent } from "./backend.js";

export interface ManualWorkspaceLiveAdapter extends WorkspaceLiveAdapter {
  emit(event: WorkspaceLiveEvent): void;
  connected(): boolean;
}

export function createManualWorkspaceLiveAdapter(): ManualWorkspaceLiveAdapter {
  let listener: ((event: WorkspaceLiveEvent) => void) | undefined;
  return {
    async connect(next) { listener = next; return () => { listener = undefined; }; },
    emit(event) { listener?.(event); },
    connected: () => listener !== undefined,
  };
}

export interface PollingWorkspaceLiveOptions {
  interval_ms?: number;
  immediate?: boolean;
  poll(signal: AbortSignal): Promise<WorkspaceLiveEvent | readonly WorkspaceLiveEvent[] | undefined>;
  on_error?: (error: unknown) => void;
}

export function createPollingWorkspaceLiveAdapter(options: PollingWorkspaceLiveOptions): WorkspaceLiveAdapter {
  return {
    async connect(listener) {
      let active = true; let timer: ReturnType<typeof setTimeout> | undefined; let controller: AbortController | undefined;
      const schedule = (): void => { if (active) timer = setTimeout(() => { void tick(); }, options.interval_ms ?? 30_000); };
      const tick = async (): Promise<void> => {
        if (!active) return; controller = new AbortController();
        try {
          const result = await options.poll(controller.signal); if (!active) return;
          const events: readonly WorkspaceLiveEvent[] = result === undefined ? [] : "type" in result ? [result] : result;
          for (const event of events) listener(event);
        } catch (caught) { if (active && !controller.signal.aborted) options.on_error?.(caught); }
        finally { controller = undefined; schedule(); }
      };
      if (options.immediate === true) void tick(); else schedule();
      return () => { active = false; if (timer !== undefined) clearTimeout(timer); controller?.abort(); };
    },
  };
}
