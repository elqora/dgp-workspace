// SPDX-License-Identifier: GPL-3.0-only

import { describe, expect, it, vi } from "vitest";

import { CommentsAPI, type BackendResult, type CommentSyncEvent, type CommentThread, type CommentsPort } from "../src/index.js";

const scope = () => ({ branch_id: "main", actor_id: "author" });
const failure = { ok: false as const, error: { code: "offline", message: "Offline", retryable: true, meta: {} } };

function thread(): CommentThread {
  return {
    id: "thread", branch_id: "main", target_path: "/fields/name", resolved: false,
    messages: [{ id: "message", author_id: "author", body: "Initial", created_at: "2026-08-09T00:00:00.000Z", edited_at: null, meta: {} }],
    created_at: "2026-08-09T00:00:00.000Z", meta: {},
  };
}

async function settle(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

describe("CommentsAPI optimistic synchronization", () => {
  it("retains a failed create job and restores the optimistic thread after retry", async () => {
    let attempt = 0;
    const save: CommentsPort["save"] = (value) => Promise.resolve(++attempt === 1 ? failure : { ok: true as const, value });
    const comments = new CommentsAPI({ scope, port: { load: () => Promise.resolve({ ok: true, value: [] }), save, delete: () => Promise.resolve({ ok: true, value: undefined }) } });
    comments.create("/fields/name", "Review"); await settle();
    expect(comments.list()).toEqual([]);
    const [job] = comments.pending_jobs(); expect(job).toBeDefined();
    expect(comments.retry_job(job as string)).toBe(true); await settle();
    expect(comments.list()).toMatchObject([{ target_path: "/fields/name", sync_state: "synced" }]);
    expect(comments.pending_jobs()).toEqual([]);
  });

  it("does not let an older failed save roll back a newer edit", async () => {
    const releases: Array<(result: BackendResult<CommentThread>) => void> = [];
    const save: CommentsPort["save"] = () => new Promise<BackendResult<CommentThread>>((resolve) => releases.push(resolve));
    const comments = new CommentsAPI({ scope, port: { load: () => Promise.resolve({ ok: true, value: [] }), save, delete: () => Promise.resolve({ ok: true, value: undefined }) } });
    comments.replace([thread()]); comments.edit_message("thread", "message", "First"); comments.edit_message("thread", "message", "Newest");
    releases[0]?.(failure); await settle();
    expect(comments.get("thread")?.messages[0]?.body).toBe("Newest");
    expect(comments.pending_jobs()).toHaveLength(1);
    releases[1]?.({ ok: true, value: { ...thread(), messages: [{ ...thread().messages[0]!, body: "Newest" }] } }); await settle();
    expect(comments.get("thread")).toMatchObject({ sync_state: "synced", messages: [{ body: "Newest" }] });
    expect(comments.pending_jobs()).toEqual([]);
  });

  it("retains failed deletes for retry and can cancel with rollback", async () => {
    let fail = true;
    const remove: CommentsPort["delete"] = () => Promise.resolve(fail ? failure : { ok: true as const, value: undefined });
    const comments = new CommentsAPI({ scope, port: { load: () => Promise.resolve({ ok: true, value: [] }), save: (value) => Promise.resolve({ ok: true, value }), delete: remove } });
    comments.replace([thread()]); comments.delete_thread("thread"); await settle();
    expect(comments.get("thread")).toMatchObject({ sync_state: "error" });
    const [job] = comments.pending_jobs(); fail = false; expect(comments.retry_job(job as string)).toBe(true); await settle();
    expect(comments.get("thread")).toBeUndefined(); expect(comments.pending_jobs()).toEqual([]);

    comments.replace([thread()]); comments.delete_thread("thread");
    const [pending] = comments.pending_jobs(); expect(comments.cancel_job(pending as string)).toBe(true);
    expect(comments.get("thread")).toMatchObject({ id: "thread" });
  });

  it("deletes individual messages optimistically and returns threads in creation order", () => {
    const comments = new CommentsAPI({ scope }); const later = thread(); later.id = "later"; later.created_at = "2026-08-10T00:00:00.000Z";
    const earlier = thread(); earlier.id = "earlier"; earlier.created_at = "2026-08-08T00:00:00.000Z";
    comments.replace([later, earlier]); expect(comments.list().map(({ id }) => id)).toEqual(["earlier", "later"]);
    comments.delete_message("later", "message"); expect(comments.get("later")).toMatchObject({ messages: [], sync_state: "synced" });
  });

  it("does not let an older load overwrite newer local hydration", async () => {
    let release: ((result: BackendResult<CommentThread[]>) => void) | undefined;
    const comments = new CommentsAPI({ scope, port: {
      load: () => new Promise<BackendResult<CommentThread[]>>((resolve) => { release = resolve; }),
      save: (value) => Promise.resolve({ ok: true, value }), delete: () => Promise.resolve({ ok: true, value: undefined }),
    } });
    const loading = comments.load_all(); const newer = thread(); newer.id = "newer"; comments.replace([newer]); release?.({ ok: true, value: [thread()] }); await loading;
    expect(comments.list().map(({ id }) => id)).toEqual(["newer"]);
  });

  it("rekeys an optimistic thread when the backend assigns its canonical id", async () => {
    const comments = new CommentsAPI({ scope, port: {
      load: () => Promise.resolve({ ok: true, value: [] }),
      save: (value) => Promise.resolve({ ok: true, value: { ...value, id: "server-thread" } }),
      delete: () => Promise.resolve({ ok: true, value: undefined }),
    } });
    const local = comments.create("/fields/name", "Review"); await settle();
    expect(comments.get(local.id)).toBeUndefined(); expect(comments.get("server-thread")).toMatchObject({ sync_state: "synced" });
  });

  it("automatically retries with bounded backoff and emits synchronization status", async () => {
    vi.useFakeTimers(); try {
      let attempt = 0; const statuses: CommentSyncEvent["status"][] = [];
      const comments = new CommentsAPI({ scope, retry: { base_delay_ms: 10, jitter: false }, on_sync: (event) => statuses.push(event.status), port: {
        load: () => Promise.resolve({ ok: true, value: [] }),
        save: (value) => Promise.resolve(++attempt === 1 ? failure : { ok: true as const, value }),
        delete: () => Promise.resolve({ ok: true, value: undefined }),
      } });
      comments.create("/fields/name", "Retry"); await settle(); expect(comments.pending_jobs()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10); await settle(); expect(comments.list()).toMatchObject([{ sync_state: "synced" }]);
      expect(statuses).toEqual(["failed", "scheduled", "retrying", "succeeded"]);
    } finally { vi.useRealTimers(); }
  });
});
