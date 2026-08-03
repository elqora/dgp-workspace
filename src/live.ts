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
