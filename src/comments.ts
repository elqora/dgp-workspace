// SPDX-License-Identifier: GPL-3.0-only

import type { BackendResult, CommentMessage, CommentThread } from "./contracts.js";

export type CommentSyncState = "pending" | "synced" | "error";
export interface SynchronizedCommentThread extends CommentThread { sync_state: CommentSyncState; sync_error?: string; }

export interface CommentsPort {
  load(branch_id: string, signal?: AbortSignal): Promise<BackendResult<CommentThread[]>>;
  save(thread: CommentThread, actor_id: string, signal?: AbortSignal): Promise<BackendResult<CommentThread>>;
  delete(thread_id: string, actor_id: string, signal?: AbortSignal): Promise<BackendResult<void>>;
}

export interface CommentsScope { branch_id: string; actor_id: string; }
export interface CommentsDependencies {
  port?: CommentsPort;
  scope?: () => CommentsScope | undefined;
  now?: () => string;
  id?: (kind: "thread" | "message" | "job") => string;
  on_change?: (thread_ids: string[]) => void;
  on_error?: (operation: string, error: unknown) => void;
  on_sync?: (event: CommentSyncEvent) => void;
  retry?: CommentRetryOptions;
}

export interface CommentRetryOptions { enabled?: boolean; max_attempts?: number; base_delay_ms?: number; max_delay_ms?: number; jitter?: boolean; }
export interface CommentSyncEvent { job_id: string; operation: string; thread_id: string; status: "scheduled" | "retrying" | "succeeded" | "failed" | "cancelled"; attempt: number; next_delay_ms?: number; error?: unknown; }

interface CommentJob {
  id: string;
  thread_id: string;
  operation: string;
  controller: AbortController;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
  run: () => Promise<void>;
  rollback: () => void;
}

function clone<T>(value: T): T { return structuredClone(value); }

export class CommentsAPI {
  readonly #dependencies: CommentsDependencies;
  readonly #threads = new Map<string, SynchronizedCommentThread>();
  readonly #revisions = new Map<string, number>();
  readonly #jobs = new Map<string, CommentJob>();
  #sequence = 1;
  #clock = 0;
  #loadRequest = 0;
  #disposed = false;

  constructor(dependencies: CommentsDependencies = {}) { this.#dependencies = dependencies; }

  list(): SynchronizedCommentThread[] { return [...this.#threads.values()].sort((left, right) => left.created_at.localeCompare(right.created_at)).map(clone); }
  get(id: string): SynchronizedCommentThread | undefined { const thread = this.#threads.get(id); return thread === undefined ? undefined : clone(thread); }

  async load_all(): Promise<BackendResult<SynchronizedCommentThread[]>> {
    const port = this.#dependencies.port; const scope = this.#dependencies.scope?.();
    if (port === undefined || scope === undefined) return { ok: true, value: this.list() };
    const request = ++this.#loadRequest; const clock = this.#clock;
    const loaded = await port.load(scope.branch_id);
    if (!loaded.ok) { this.#dependencies.on_error?.("load", loaded.error); return loaded; }
    if (this.#disposed || request !== this.#loadRequest || clock !== this.#clock) return { ok: true, value: this.list() };
    this.#threads.clear(); this.#revisions.clear();
    for (const thread of loaded.value) { this.#threads.set(thread.id, { ...clone(thread), sync_state: "synced" }); this.#revisions.set(thread.id, 0); }
    this.#changed(); return { ok: true, value: this.list() };
  }

  create(targetPath: string, body: string, meta: Record<string, unknown> = {}): SynchronizedCommentThread {
    const scope = this.#requiredScope(); const now = this.#now(); const id = this.#id("thread");
    const thread: SynchronizedCommentThread = {
      id, branch_id: scope.branch_id, target_path: targetPath, resolved: false,
      messages: [{ id: this.#id("message"), author_id: scope.actor_id, body, created_at: now, edited_at: null, meta: {} }],
      created_at: now, meta: clone(meta), sync_state: "pending",
    };
    this.#threads.set(id, thread); this.#revisions.set(id, 1); this.#clock += 1; this.#changed(); this.#queueSave(id, "create", undefined); return clone(thread);
  }

  reply(threadId: string, body: string, meta: Record<string, unknown> = {}): CommentMessage {
    const scope = this.#requiredScope(); const thread = this.#require(threadId); const before = clone(thread);
    const message: CommentMessage = { id: this.#id("message"), author_id: scope.actor_id, body, created_at: this.#now(), edited_at: null, meta: clone(meta) };
    thread.messages.push(message); this.#optimistic(thread); this.#queueSave(threadId, "reply", before); return clone(message);
  }

  edit_message(threadId: string, messageId: string, body: string): void {
    const thread = this.#require(threadId); const before = clone(thread);
    const message = thread.messages.find((candidate) => candidate.id === messageId); if (message === undefined) throw new Error(`Unknown comment message ${messageId}.`);
    message.body = body; message.edited_at = this.#now(); this.#optimistic(thread); this.#queueSave(threadId, "edit", before);
  }

  delete_message(threadId: string, messageId: string): void {
    const thread = this.#require(threadId); const before = clone(thread);
    const messages = thread.messages.filter((candidate) => candidate.id !== messageId); if (messages.length === thread.messages.length) return;
    thread.messages = messages; this.#optimistic(thread); this.#queueSave(threadId, "delete_message", before);
  }

  move(threadId: string, targetPath: string): void {
    const thread = this.#require(threadId); const before = clone(thread); thread.target_path = targetPath;
    this.#optimistic(thread); this.#queueSave(threadId, "move", before);
  }

  resolve(threadId: string, resolved = true): void {
    const thread = this.#require(threadId); const before = clone(thread); thread.resolved = resolved;
    this.#optimistic(thread); this.#queueSave(threadId, "resolve", before);
  }

  delete_thread(threadId: string): void {
    const scope = this.#requiredScope(); const thread = this.#require(threadId); const before = clone(thread);
    this.#threads.delete(threadId); const revision = this.#nextRevision(threadId); this.#clock += 1; this.#changed();
    const port = this.#dependencies.port; if (port === undefined) return;
    const id = this.#id("job");
    const rollback = (): void => {
      if ((this.#revisions.get(threadId) ?? 0) !== revision) return;
      this.#threads.set(threadId, { ...before, sync_state: "error", sync_error: "Delete failed." }); this.#clock += 1; this.#changed();
    };
    const job: CommentJob = { id, thread_id: threadId, operation: "delete", controller: new AbortController(), attempt: 0, rollback, run: async () => {
      this.#started(job);
      const controller = job.controller; const result = await port.delete(threadId, scope.actor_id, controller.signal);
      if (this.#jobs.get(id) !== job || job.controller !== controller) return;
      if (!result.ok) {
        rollback(); this.#dependencies.on_error?.("delete", result.error);
        if ((this.#revisions.get(threadId) ?? 0) !== revision) this.#jobs.delete(id); else this.#failed(job, result.error);
        return;
      }
      if ((this.#revisions.get(threadId) ?? 0) === revision) { this.#threads.delete(threadId); this.#revisions.delete(threadId); this.#clock += 1; this.#changed(); }
      this.#succeeded(job);
    } };
    this.#jobs.set(id, job); void job.run();
  }

  retry_job(jobId: string): boolean {
    const existing = this.#jobs.get(jobId); if (existing === undefined) return false;
    existing.controller.abort(); if (existing.timer !== undefined) clearTimeout(existing.timer); delete existing.timer;
    existing.controller = new AbortController(); void existing.run(); return true;
  }

  cancel_job(jobId: string): boolean {
    const job = this.#jobs.get(jobId); if (job === undefined) return false;
    job.controller.abort(); if (job.timer !== undefined) clearTimeout(job.timer); job.rollback(); this.#jobs.delete(jobId);
    this.#dependencies.on_sync?.({ job_id: job.id, operation: job.operation, thread_id: job.thread_id, status: "cancelled", attempt: job.attempt }); return true;
  }

  pending_jobs(): string[] { return [...this.#jobs.keys()]; }

  replace(threads: readonly CommentThread[]): void {
    this.#clock += 1;
    this.#threads.clear(); this.#revisions.clear();
    for (const thread of threads) { this.#threads.set(thread.id, { ...clone(thread), sync_state: "synced" }); this.#revisions.set(thread.id, 0); }
    this.#changed();
  }

  dispose(): void { this.#disposed = true; for (const job of this.#jobs.values()) { job.controller.abort(); if (job.timer !== undefined) clearTimeout(job.timer); } this.#jobs.clear(); }

  #queueSave(threadId: string, operation: string, before: SynchronizedCommentThread | undefined): void {
    const port = this.#dependencies.port; const scope = this.#dependencies.scope?.(); if (port === undefined || scope === undefined) {
      const thread = this.#threads.get(threadId); if (thread !== undefined) thread.sync_state = "synced"; this.#changed(); return;
    }
    const revision = this.#revisions.get(threadId) ?? 0; const id = this.#id("job");
    const pending = this.#threads.get(threadId);
    if (pending === undefined) return;
    const payload = this.#plain(pending);
    const rollback = (): void => {
      if ((this.#revisions.get(threadId) ?? 0) !== revision) return;
      if (before === undefined) this.#threads.delete(threadId);
      else this.#threads.set(threadId, { ...clone(before), sync_state: "error", sync_error: `${operation} failed.` });
      this.#clock += 1; this.#changed();
    };
    const job: CommentJob = { id, thread_id: threadId, operation, controller: new AbortController(), attempt: 0, rollback, run: async () => {
      this.#started(job);
      const controller = job.controller; const result = await port.save(clone(payload), scope.actor_id, controller.signal);
      if (this.#jobs.get(id) !== job || job.controller !== controller) return;
      if (!result.ok) {
        rollback(); this.#dependencies.on_error?.(operation, result.error);
        if ((this.#revisions.get(threadId) ?? 0) !== revision) this.#jobs.delete(id); else this.#failed(job, result.error);
        return;
      }
      if ((this.#revisions.get(threadId) ?? 0) === revision) {
        const serverId = result.value.id; this.#threads.delete(threadId); this.#threads.set(serverId, { ...clone(result.value), sync_state: "synced" });
        if (serverId !== threadId) { this.#revisions.delete(threadId); this.#revisions.set(serverId, revision); }
        this.#clock += 1;
      }
      this.#succeeded(job); this.#changed();
    } };
    this.#jobs.set(id, job); void job.run();
  }

  #plain(thread: SynchronizedCommentThread): CommentThread {
    const plain = clone(thread) as Partial<SynchronizedCommentThread>; delete plain.sync_state; delete plain.sync_error; return plain as CommentThread;
  }

  #optimistic(thread: SynchronizedCommentThread): void {
    thread.sync_state = "pending"; delete thread.sync_error; this.#nextRevision(thread.id); this.#clock += 1; this.#changed();
  }

  #nextRevision(threadId: string): number { const revision = (this.#revisions.get(threadId) ?? 0) + 1; this.#revisions.set(threadId, revision); return revision; }
  #started(job: CommentJob): void { if (job.timer !== undefined) clearTimeout(job.timer); delete job.timer; job.attempt += 1; if (job.attempt > 1) this.#dependencies.on_sync?.({ job_id: job.id, operation: job.operation, thread_id: job.thread_id, status: "retrying", attempt: job.attempt }); }
  #failed(job: CommentJob, failure: unknown): void {
    if (this.#jobs.get(job.id) !== job) return;
    this.#dependencies.on_sync?.({ job_id: job.id, operation: job.operation, thread_id: job.thread_id, status: "failed", attempt: job.attempt, error: failure });
    const options = this.#dependencies.retry; const enabled = options?.enabled ?? true; const maximum = options?.max_attempts ?? 5;
    if (!enabled || job.attempt >= maximum) { this.#jobs.delete(job.id); return; }
    const base = options?.base_delay_ms ?? 800; const ceiling = options?.max_delay_ms ?? 20_000; let delay = Math.min(ceiling, base * 2 ** Math.max(0, job.attempt - 1));
    if (options?.jitter ?? true) delay = Math.min(ceiling, Math.floor(delay * (0.8 + Math.random() * 0.4)));
    this.#dependencies.on_sync?.({ job_id: job.id, operation: job.operation, thread_id: job.thread_id, status: "scheduled", attempt: job.attempt, next_delay_ms: delay });
    job.timer = setTimeout(() => { job.controller = new AbortController(); void job.run(); }, delay);
  }
  #succeeded(job: CommentJob): void { this.#jobs.delete(job.id); this.#dependencies.on_sync?.({ job_id: job.id, operation: job.operation, thread_id: job.thread_id, status: "succeeded", attempt: job.attempt }); }
  #require(id: string): SynchronizedCommentThread { const thread = this.#threads.get(id); if (thread === undefined) throw new Error(`Unknown comment thread ${id}.`); return thread; }
  #requiredScope(): CommentsScope { return this.#dependencies.scope?.() ?? { branch_id: "local", actor_id: "local" }; }
  #now(): string { return this.#dependencies.now?.() ?? new Date().toISOString(); }
  #id(kind: "thread" | "message" | "job"): string { return this.#dependencies.id?.(kind) ?? `${kind}-${this.#sequence++}`; }
  #changed(): void { if (!this.#disposed) this.#dependencies.on_change?.([...this.#threads.keys()]); }
}
