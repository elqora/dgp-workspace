// SPDX-License-Identifier: GPL-3.0-only

import type { ProductDefinition } from "@elqora/dgp-spec";
import { describe, expect, it, vi } from "vitest";

import {
  MemoryWorkspaceBackend,
  WorkspaceRuntime,
  createManualWorkspaceLiveAdapter,
  createPollingWorkspaceLiveAdapter,
  type CommentThread,
  type FieldTemplate,
  type WorkspacePermissions,
  type SaveDraftInput,
  type MemoryWorkspaceSnapshot,
  mergeWorkspaceTemplates,
} from "../src/index.js";

function definition(): ProductDefinition {
  return {
    id: "product", name: "Product", schema_version: "1",
    filters: [{ id: "root", label: "Root" }], fields: [],
    order_for_tags: {}, includes_for_buttons: {}, excludes_for_buttons: {},
    option_effects_for_buttons: {}, value_effects_for_triggers: {}, fallbacks: null,
    description: null, notices: [], meta: {},
  };
}

const actor = { id: "author-1", display_name: "Editor", meta: {} };

describe("WorkspaceRuntime", () => {
  it("provides a transport-neutral polling live adapter with cancellation", async () => {
    vi.useFakeTimers(); try {
      const listener = vi.fn(); const poll = vi.fn(() => Promise.resolve({ type: "workspace.invalidate" as const }));
      const disconnect = await createPollingWorkspaceLiveAdapter({ interval_ms: 10, poll }).connect(listener);
      await vi.advanceTimersByTimeAsync(10); expect(poll).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledWith({ type: "workspace.invalidate" });
      disconnect(); await vi.advanceTimersByTimeAsync(30); expect(poll).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("does not clear newer edits when an older autosave finishes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class DelayedBackend extends MemoryWorkspaceBackend {
      override async save_draft(input: SaveDraftInput) {
        await gate;
        return super.save_draft(input);
      }
    }
    const runtime = new WorkspaceRuntime(new DelayedBackend({ definition: definition() }), { actor, auto_autosave: false });
    await runtime.boot();
    runtime.mutate((document) => ({ ...document, name: "First edit" }));
    const saving = runtime.autosave();
    runtime.mutate((document) => ({ ...document, name: "Newer edit" }));
    release?.();
    await saving;
    expect(runtime.state.definition?.name).toBe("Newer edit");
    expect(runtime.state.draft?.definition.name).toBe("First edit");
    expect(runtime.state.snapshot_state).toBe("dirty");
  });

  it("protects runtime state from mutation through getters and subscriptions", async () => {
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false });
    runtime.subscribe((state) => { if (state.definition !== null) state.definition.name = "Listener mutation"; }); await runtime.boot();
    const exposed = runtime.state; if (exposed.definition !== null) exposed.definition.name = "Getter mutation";
    expect(runtime.state.definition?.name).toBe("Product");
  });

  it("does not let a branch refresh overwrite an edit made while loading", async () => {
    let release: (() => void) | undefined; const gate = new Promise<void>((resolve) => { release = resolve; });
    class DelayedRefreshBackend extends MemoryWorkspaceBackend {
      override async load_branch(branchId: string) { await gate; return super.load_branch(branchId); }
    }
    const runtime = new WorkspaceRuntime(new DelayedRefreshBackend({ definition: definition() }), { actor, auto_autosave: false });
    await runtime.boot(); const refreshing = runtime.refresh_branch(); runtime.mutate((document) => ({ ...document, name: "Local while loading" })); release?.(); await refreshing;
    expect(runtime.state.definition?.name).toBe("Local while loading"); expect(runtime.state.snapshot_state).toBe("dirty");
  });

  it("boots, autosaves, commits, and preserves branch-local cached mutations", async () => {
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false });
    expect(await runtime.boot()).toEqual({ ok: true, value: undefined });
    expect(runtime.state.status).toBe("ready");
    runtime.mutate((document) => ({ ...document, name: "Main edited" }));
    expect(runtime.state.snapshot_state).toBe("dirty");
    expect(await runtime.autosave()).toMatchObject({ ok: true, value: { definition: { name: "Main edited" } } });
    expect(runtime.state.snapshot_state).toBe("uncommitted");
    const committed = await runtime.commit("First commit");
    expect(committed).toMatchObject({ ok: true, value: { message: "First commit" } });
    if (!committed.ok) throw new Error("commit failed");
    expect(runtime.state.snapshot_state).toBe("clean");

    await runtime.create_branch("Feature");
    runtime.mutate((document) => ({ ...document, name: "Feature edited" }));
    await runtime.switch_branch("main");
    expect(runtime.state.definition?.name).toBe("Main edited");
    const featureId = runtime.state.branches.find((branch) => branch.name === "Feature")?.id;
    if (featureId === undefined) throw new Error("missing feature branch");
    await runtime.switch_branch(featureId);
    expect(runtime.state.definition?.name).toBe("Feature edited");
    await runtime.set_main(featureId);
    expect(runtime.state.branches.find((branch) => branch.id === featureId)?.main).toBe(true);
    await runtime.switch_branch("main");
    runtime.mutate((document) => ({ ...document, name: "Temporary" }));
    expect(await runtime.restore_snapshot(committed.value.id)).toEqual({ ok: true, value: undefined });
    expect(runtime.state.definition?.name).toBe("Main edited");
    expect(runtime.state.snapshot_state).toBe("dirty");
    runtime.dispose();
  });

  it("persists and restores complete framework-neutral editorial state", async () => {
    const backend = new MemoryWorkspaceBackend({ definition: definition() });
    const first = new WorkspaceRuntime(backend, { actor, auto_autosave: false }); await first.boot();
    first.canvas?.set_position("root", 12, 34); first.canvas?.set_viewport({ x: 8, y: 9, zoom: 1.5 }); first.canvas?.select(["root"]);
    first.canvas?.set_highlighted(["root"]); first.canvas?.set_edge_mode("exclude"); first.editor?.create_catalog_group("Editorial");
    expect(first.state.snapshot_state).toBe("dirty"); expect(await first.commit("Editorial state")).toMatchObject({ ok: true }); first.dispose();

    const second = new WorkspaceRuntime(backend, { actor, auto_autosave: false }); await second.boot();
    expect(second.canvas?.editorial_state()).toMatchObject({
      positions: { root: { x: 12, y: 34 } }, viewport: { x: 8, y: 9, zoom: 1.5 }, selection_ids: ["root"],
      highlighted_ids: ["root"], edge_mode: "exclude", catalog: { nodes: [{ label: "Editorial" }] },
    });
    expect(second.state.snapshot_state).toBe("clean");
  });

  it("rehydrates the development backend through a host persistence port and prefers stored state over a later seed", async () => {
    let stored: MemoryWorkspaceSnapshot | undefined; let saves = 0;
    const persistence = {
      load() { return Promise.resolve(stored === undefined ? undefined : structuredClone(stored)); },
      save(snapshot: MemoryWorkspaceSnapshot) { saves += 1; stored = structuredClone(snapshot); return Promise.resolve(); },
    };
    const firstBackend = new MemoryWorkspaceBackend({ workspace_id: "persisted", definition: definition(), persistence });
    const first = new WorkspaceRuntime(firstBackend, { actor, auto_autosave: false }); await first.boot(); first.mutate((document) => ({ ...document, name: "Persisted" })); await first.commit(); first.dispose();
    const replacementSeed = definition(); replacementSeed.name = "Replacement seed";
    const second = new WorkspaceRuntime(new MemoryWorkspaceBackend({ workspace_id: "persisted", definition: replacementSeed, persistence }), { actor, auto_autosave: false }); await second.boot();
    expect(second.state.definition?.name).toBe("Persisted"); expect(saves).toBeGreaterThanOrEqual(2);
  });

  it("gates publication through reusable Validation", async () => {
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false });
    await runtime.boot();
    runtime.mutate((document) => ({
      ...document,
      fields: [{ id: "orphan", type: "text", label: "Orphan", bind_id: "missing" }],
    }));
    const rejected = await runtime.publish();
    expect(rejected).toMatchObject({ ok: false, error: { code: "publication_validation_failed" } });
    expect(runtime.state.validation?.publishable).toBe(false);

    runtime.replace(definition());
    const published = await runtime.publish("Release");
    expect(published).toMatchObject({ ok: true, value: { commit: { message: "Release" } } });
    expect(runtime.state.snapshot_state).toBe("clean");
  });

  it("hydrates backend-owned JSON policy rules and applies them during publication", async () => {
    const backend = new MemoryWorkspaceBackend({ definition: definition(), policy_rules: [{
      id: "require-service", label: "Require a service", scope: "global", subject: "services", filter: { role: "both" },
      projection: "service.id", op: "min_count", value: 1, severity: "error",
    }] });
    const runtime = new WorkspaceRuntime(backend, { actor, auto_autosave: false }); await runtime.boot();
    expect(runtime.state.policy_rules).toHaveLength(1); expect(await runtime.publish()).toMatchObject({ ok: false, error: { code: "publication_validation_failed" } });
    expect(runtime.state.validation?.policyDiagnostics).toMatchObject([{ code: "host_service_policy_violation" }]);
  });

  it("accepts host authorization decisions without defining presentation", async () => {
    const permissions = Object.fromEntries([
      "document.mutate", "draft.save", "commit.create", "publish", "branch.create",
      "branch.set_main", "branch.merge", "branch.delete", "template.write", "comment.write",
    ].map((action) => [action, action !== "publish"])) as WorkspacePermissions;
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition(), permissions }), { actor });
    await runtime.boot();
    expect(await runtime.publish()).toMatchObject({ ok: false, error: { code: "authorization_denied", meta: { action: "publish" } } });
  });

  it("tracks boot sections, keeps comments failures non-blocking, and exposes blocking partial failures", async () => {
    class PartialBackend extends MemoryWorkspaceBackend {
      constructor(private readonly section: "comments" | "services") { super({ definition: definition() }); }
      override async load(actorInput: typeof actor, preferred?: string) {
        const loaded = await super.load(actorInput, preferred); if (!loaded.ok) return loaded;
        return { ok: true as const, value: { ...loaded.value, section_errors: { [this.section]: { code: "section_failed", message: "Unavailable", retryable: true, meta: {} } } } };
      }
    }
    const nonBlocking = new WorkspaceRuntime(new PartialBackend("comments"), { actor, auto_autosave: false }); await nonBlocking.boot();
    expect(nonBlocking.state).toMatchObject({ status: "ready", boot_partial_failure: true, boot_sections: { comments: "error" }, error: null });
    const blocking = new WorkspaceRuntime(new PartialBackend("services"), { actor, auto_autosave: false }); await blocking.boot();
    expect(blocking.state).toMatchObject({ status: "error", boot_partial_failure: true, boot_sections: { services: "error" }, error: { code: "section_failed" } });
  });

  it("uses distinct permissions for draft disposal and main-branch changes", async () => {
    const permissions = Object.fromEntries([
      "document.mutate", "draft.save", "commit.create", "publish", "branch.create",
      "branch.set_main", "branch.merge", "branch.delete", "template.write", "comment.write",
    ].map((action) => [action, action !== "draft.save" && action !== "branch.set_main"])) as WorkspacePermissions;
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition(), permissions }), { actor });
    await runtime.boot();
    expect(await runtime.discard_draft()).toMatchObject({
      ok: false, error: { code: "authorization_denied", meta: { action: "draft.save" } },
    });
    expect(await runtime.set_main("main")).toMatchObject({
      ok: false, error: { code: "authorization_denied", meta: { action: "branch.set_main" } },
    });
  });

  it("enforces comment authorization through the Canvas comments bridge", async () => {
    const permissions = Object.fromEntries([
      "document.mutate", "draft.save", "commit.create", "publish", "branch.create",
      "branch.set_main", "branch.merge", "branch.delete", "template.write", "comment.write",
    ].map((action) => [action, action !== "comment.write"])) as WorkspacePermissions;
    let backendWrites = 0;
    class TrackingBackend extends MemoryWorkspaceBackend {
      override async save_comment(thread: CommentThread) { backendWrites += 1; return super.save_comment(thread); }
    }
    const runtime = new WorkspaceRuntime(new TrackingBackend({ definition: definition(), permissions }), { actor, auto_autosave: false }); await runtime.boot();
    runtime.canvas?.comments.create("/fields/name", "Blocked"); await Promise.resolve(); await Promise.resolve();
    expect(backendWrites).toBe(0); expect(runtime.canvas?.comments.pending_jobs()).toHaveLength(1); expect(runtime.canvas?.comments.list()).toEqual([]);
  });

  it("defers live refreshes that would overwrite unsaved changes", async () => {
    const live = createManualWorkspaceLiveAdapter();
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), {
      actor, live, auto_autosave: false,
    });
    await runtime.boot();
    runtime.mutate((document) => ({ ...document, name: "Local edit" }));
    live.emit({ type: "workspace.invalidate" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.state.definition?.name).toBe("Local edit");
    expect(runtime.state.snapshot_state).toBe("dirty");
    expect(runtime.state.error).toMatchObject({ code: "live_update_deferred", retryable: true });
  });

  it("coordinates templates, comments, subscriptions, and live invalidation", async () => {
    const live = createManualWorkspaceLiveAdapter();
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, live, auto_autosave: false });
    let updates = 0;
    runtime.subscribe(() => updates += 1);
    await runtime.boot();
    expect(live.connected()).toBe(true);
    const template: FieldTemplate = {
      id: "template-1", key: "email", name: "Email", branch_id: "main", published: false,
      field: { id: "email", type: "text", label: "Email", bind_id: "root" },
      updated_at: "2026-08-03T00:00:00.000Z", meta: {},
    };
    expect(await runtime.save_template(template)).toMatchObject({ ok: true });
    const thread: CommentThread = {
      id: "thread-1", branch_id: "main", target_path: "/fields/0", resolved: false,
      messages: [{ id: "message-1", author_id: actor.id, body: "Review", created_at: "2026-08-03T00:00:00.000Z", edited_at: null, meta: {} }],
      created_at: "2026-08-03T00:00:00.000Z", meta: {},
    };
    expect(await runtime.save_comment(thread)).toMatchObject({ ok: true });
    live.emit({ type: "branch.invalidate", branch_id: "main" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.state.templates).toHaveLength(1);
    expect(runtime.state.comments).toHaveLength(1);
    expect(updates).toBeGreaterThan(3);
    runtime.dispose();
    expect(live.connected()).toBe(false);
  });

  it("supports the complete template create, update, clone, publish, unpublish, and delete lifecycle", async () => {
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false }); await runtime.boot();
    const created = await runtime.create_template({ key: "email", name: "Email", branch_id: "main", published: false, field: { id: "email", type: "text", label: "Email" }, meta: {} });
    expect(created).toMatchObject({ ok: true, value: { key: "email", published: false } }); if (!created.ok) throw new Error("create failed");
    expect(await runtime.update_template(created.value.id, { name: "Work email" })).toMatchObject({ ok: true, value: { name: "Work email" } });
    expect(await runtime.publish_template(created.value.id)).toMatchObject({ ok: true, value: { published: true } });
    expect(await runtime.unpublish_template(created.value.id)).toMatchObject({ ok: true, value: { published: false } });
    const cloned = await runtime.clone_template({ id: created.value.id }, { key: "email-copy" }); expect(cloned).toMatchObject({ ok: true, value: { key: "email-copy", published: false } });
    expect(await runtime.clone_template({ id: created.value.id }, { key: "email-copy" })).toMatchObject({ ok: false, error: { code: "template_key_conflict" } });
    expect(await runtime.delete_template(created.value.id)).toEqual({ ok: true, value: undefined }); expect(runtime.state.templates).toHaveLength(1);
  });

  it("merges template deltas by timestamp without inferring deletion unless reconciliation is explicit", () => {
    const base = (id: string, updated_at: string, name = id): FieldTemplate => ({ id, key: id, name, branch_id: "main", published: true, field: { id, type: "text", label: name }, updated_at, meta: {} });
    const current = [base("old", "2026-01-01T00:00:00.000Z"), base("changed", "2026-08-09T00:00:00.000Z", "local"), base("missing", "2026-08-08T00:00:00.000Z")];
    const merged = mergeWorkspaceTemplates(current, [base("changed", "2026-08-01T00:00:00.000Z", "stale"), base("new", "2026-08-10T00:00:00.000Z")], { since: "2026-08-01T00:00:00.000Z" });
    expect(merged.find(({ id }) => id === "changed")?.name).toBe("local"); expect(merged.some(({ id }) => id === "missing")).toBe(true); expect(merged.some(({ id }) => id === "new")).toBe(true);
    const reconciled = mergeWorkspaceTemplates(current, [], { since: "2026-08-01T00:00:00.000Z", reconcile_missing_since: true });
    expect(reconciled.map(({ id }) => id)).toEqual(["old"]);
  });
});
