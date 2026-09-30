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

  it("captures connected fields and instantiates fresh recursive identities in one undo step", async () => {
    const product = definition();
    product.fields = [
      { id: "choice", type: "select", label: "Choice", bind_id: "root", default_value: "nested", options: [{ id: "outer", label: "Outer", children: [{ id: "nested", label: "Nested", service_id: "service-1" }] }] },
      { id: "detail", type: "text", label: "Detail", bind_id: "nested" },
      { id: "unrelated", type: "text", label: "Other", bind_id: "root" },
    ];
    product.includes_for_buttons = { nested: ["detail"] };
    product.value_effects_for_triggers = { nested: { detail: { value: "nested" } } };
    product.fallbacks = { nodes: { nested: ["service-1"] } };
    product.notices = [{ id: "notice", type: "public", kind: "label", severity: "info", target: { scope: "node", node_kind: "option", node_id: "nested" }, title: "Help" }];
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: product }), { actor, auto_autosave: false });
    await runtime.boot();
    const captured = runtime.capture_field_template("choice", true);
    expect(captured.ok).toBe(true); if (!captured.ok) return;
    expect(captured.value.connected_fields?.map((field) => field.id)).toEqual(["detail"]);
    const single = runtime.capture_field_template("choice");
    expect(single.ok).toBe(true);
    if (single.ok) expect(single.value.connected_fields).toBeUndefined();
    const saved = await runtime.create_template({ key: "choice", name: "Choice", branch_id: "main", published: false, ...captured.value, meta: {} });
    expect(saved.ok).toBe(true); if (!saved.ok) return;
    const first = runtime.instantiate_template(saved.value.id, { bind_id: "root" });
    const second = runtime.instantiate_template(saved.value.id, { bind_id: "root" });
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
    const left = first.value.id_map; const right = second.value.id_map;
    for (const old of ["choice", "outer", "nested", "detail", "notice"]) {
      expect(left[old]).toBeTruthy(); expect(right[old]).toBeTruthy();
      expect(left[old]).not.toBe(old); expect(right[old]).not.toBe(left[old]);
    }
    const document = runtime.state.definition as ProductDefinition;
    expect(document.fields.find((field) => field.id === right.choice)?.default_value).toBe(right.nested);
    expect(document.fields.find((field) => field.id === right.detail)?.bind_id).toBe(right.nested);
    expect(document.includes_for_buttons[right.nested as string]).toEqual([right.detail]);
    expect(document.value_effects_for_triggers[right.nested as string]?.[right.detail as string]?.value).toBe("nested");
    expect(document.fallbacks?.nodes?.[right.nested as string]).toEqual(["service-1"]);
    expect(document.notices.find((notice) => notice.id === right.notice)?.target).toMatchObject({ node_id: right.nested });
    expect(document.fields.find((field) => field.id === "choice")?.options?.[0]?.children?.[0]?.id).toBe("nested");
    runtime.editor?.undo();
    expect(runtime.state.definition?.fields.some((field) => field.id === right.choice)).toBe(false);
    runtime.editor?.redo();
    expect(runtime.state.definition?.fields.some((field) => field.id === right.choice)).toBe(true);
  });

  it("captures a selected field subset and properties without dangling references", async () => {
    const product = definition();
    product.fields = [
      { id: "root-field", type: "select", label: "Root", description: "Omit this", default_value: "option-a", options: [{ id: "option-a", label: "A" }] },
      { id: "keep", type: "text", label: "Keep", bind_id: "option-a", description: "Also omit" },
      { id: "drop", type: "text", label: "Drop", bind_id: "option-a" },
    ];
    product.includes_for_buttons = { "option-a": ["keep", "drop"] };
    product.notices = [{ id: "note", type: "public", kind: "label", severity: "info", target: { scope: "node", node_kind: "option", node_id: "option-a" }, title: "Help" }];
    product.fallbacks = { nodes: { "option-a": ["service-1"] } };
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: product }), { actor, auto_autosave: false });
    await runtime.boot();
    const captured = runtime.capture_field_template("root-field", {
      include_connected: true,
      field_ids: ["root-field", "keep"],
      property_keys: { "root-field": ["id", "type", "label"], keep: ["id", "type", "label", "bind_id"] },
    });
    expect(captured.ok).toBe(true); if (!captured.ok) return;
    expect(captured.value.field).toEqual({ id: "root-field", type: "select", label: "Root" });
    expect(captured.value.connected_fields).toEqual([{ id: "keep", type: "text", label: "Keep" }]);
    expect(captured.value.relationships?.includes_for_buttons).toEqual({});
    expect(captured.value.notices).toBeUndefined();
    expect(captured.value.fallbacks).toBeUndefined();
    const saved = await runtime.create_template({ key: "selected", name: "Named template", group_label: "Separate group", branch_id: "main", published: false, ...captured.value, meta: {} });
    expect(saved).toMatchObject({ ok: true, value: { group_label: "Separate group" } });
    if (!saved.ok) return;
    const copy = await runtime.clone_template({ id: saved.value.id }, { key: "selected-copy" });
    expect(copy).toMatchObject({ ok: true, value: { group_label: "Separate group" } });
    const first = runtime.instantiate_template(saved.value.id);
    const second = runtime.instantiate_template(saved.value.id);
    expect(first.ok && second.ok).toBe(true); if (!first.ok || !second.ok) return;
    expect(first.value.field_ids).toHaveLength(2);
    expect(first.value.id_map["root-field"]).not.toBe(second.value.id_map["root-field"]);
    expect(first.value.id_map.keep).not.toBe(second.value.id_map.keep);
    expect(first.value.id_map.drop).toBeUndefined();
    const withOptions = runtime.capture_field_template("root-field", {
      field_ids: ["root-field", "keep"],
      property_keys: { "root-field": ["id", "type", "label", "options", "default_value"], keep: ["id", "type", "label", "bind_id"] },
    });
    expect(withOptions.ok).toBe(true); if (!withOptions.ok) return;
    expect(withOptions.value.relationships?.includes_for_buttons["option-a"]).toEqual(["keep"]);
    const optionTemplate = await runtime.create_template({ key: "selected-options", name: "With options", branch_id: "main", published: false, ...withOptions.value, meta: {} });
    expect(optionTemplate.ok).toBe(true); if (!optionTemplate.ok) return;
    const optionFirst = runtime.instantiate_template(optionTemplate.value.id);
    const optionSecond = runtime.instantiate_template(optionTemplate.value.id);
    expect(optionFirst.ok && optionSecond.ok).toBe(true); if (!optionFirst.ok || !optionSecond.ok) return;
    expect(optionFirst.value.id_map["option-a"]).toBeTruthy();
    expect(optionFirst.value.id_map["option-a"]).not.toBe(optionSecond.value.id_map["option-a"]);
    expect(optionFirst.value.id_map.drop).toBeUndefined();
  });

  it("rejects invalid selective template capture with a structured error", async () => {
    const product = definition();
    product.fields = [{ id: "x", type: "text", label: "X" }, { id: "other", type: "text", label: "Other" }];
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: product }), { actor, auto_autosave: false });
    await runtime.boot();
    expect(runtime.capture_field_template("x", { field_ids: ["missing"] })).toMatchObject({ ok: false, error: { code: "template_invalid" } });
    expect(runtime.capture_field_template("x", { field_ids: ["x", "other"] })).toMatchObject({ ok: false, error: { code: "template_invalid" } });
    expect(runtime.capture_field_template("x", { field_ids: ["x"], property_keys: { x: ["id", "type"] } })).toMatchObject({ ok: false, error: { code: "template_invalid" } });
  });

  it("keeps global templates visible across branches and preserves explicit global clone scope", async () => {
    const backend = new MemoryWorkspaceBackend({ definition: definition() });
    const runtime = new WorkspaceRuntime(backend, { actor, auto_autosave: false }); await runtime.boot();
    const global = await runtime.create_template({ key: "shared", name: "Shared", branch_id: null, published: false, field: { id: "shared", type: "text", label: "Shared" }, meta: {} });
    expect(global).toMatchObject({ ok: true, value: { branch_id: null } }); if (!global.ok) return;
    const branch = await runtime.create_branch("Feature"); expect(branch.ok).toBe(true);
    const branchId = runtime.state.current_branch_id as string;
    expect(runtime.state.templates.some((item) => item.id === global.value.id)).toBe(true);
    const privateCopy = await runtime.clone_template({ id: global.value.id }, { key: "private", branch_id: branchId });
    expect(privateCopy).toMatchObject({ ok: true, value: { branch_id: branchId } });
    const globalCopy = await runtime.clone_template({ id: privateCopy.ok ? privateCopy.value.id : "" }, { key: "shared-copy", branch_id: null });
    expect(globalCopy).toMatchObject({ ok: true, value: { branch_id: null } });
    expect(await runtime.switch_branch("main")).toMatchObject({ ok: true });
    expect(runtime.state.templates.map((item) => item.key).sort()).toEqual(["shared", "shared-copy"]);
    expect(await runtime.create_template({ key: "private", name: "Private global", branch_id: null, published: false, field: { id: "x", type: "text", label: "X" }, meta: {} })).toMatchObject({ ok: false, error: { code: "template_key_conflict" } });
    expect(await runtime.switch_branch(branchId)).toMatchObject({ ok: true });
    expect(runtime.state.templates.map((item) => item.key).sort()).toEqual(["private", "shared", "shared-copy"]);
    expect(await runtime.delete_template(global.value.id)).toMatchObject({ ok: true });
    expect(await runtime.switch_branch("main")).toMatchObject({ ok: true });
    expect(runtime.state.templates.map((item) => item.key)).toEqual(["shared-copy"]);
  });

  it("persists global templates without duplicating them into branches and migrates old null-scoped records", async () => {
    let stored: MemoryWorkspaceSnapshot | undefined;
    const persistence = {
      load() { return Promise.resolve(stored === undefined ? undefined : structuredClone(stored)); },
      save(snapshot: MemoryWorkspaceSnapshot) { stored = structuredClone(snapshot); return Promise.resolve(); },
    };
    const backend = new MemoryWorkspaceBackend({ definition: definition(), persistence });
    const runtime = new WorkspaceRuntime(backend, { actor, auto_autosave: false }); await runtime.boot();
    const global = await runtime.create_template({ key: "all", name: "All", group_label: "Separate label", branch_id: null, published: false, field: { id: "all", type: "text", label: "All" }, meta: {} });
    expect(global.ok).toBe(true);
    expect(await runtime.create_branch("Feature")).toMatchObject({ ok: true });
    expect(stored?.global_templates?.map((item) => item.key)).toEqual(["all"]);
    expect(stored?.branches.every((branch) => branch.templates.length === 0)).toBe(true);
    const restored = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition(), persistence }), { actor, auto_autosave: false }); await restored.boot();
    expect(restored.state.templates.map((item) => item.key)).toEqual(["all"]);
    expect(restored.state.templates[0]?.group_label).toBe("Separate label");
    if (global.ok && stored !== undefined) {
      const legacy = structuredClone(stored);
      legacy.global_templates = [];
      legacy.branches[0]?.templates.push(global.value);
      stored = legacy;
      const migrated = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition(), persistence }), { actor, auto_autosave: false }); await migrated.boot();
      expect(migrated.state.templates.map((item) => item.key)).toEqual(["all"]);
    }
  });

  it("saves global templates when the main branch has a nonliteral ID", async () => {
    const initial = new MemoryWorkspaceBackend({ definition: definition() }).snapshot();
    const main = initial.branches[0]; if (main === undefined) throw new Error("Missing main branch.");
    main.branch.id = "branch:main";
    const persistence = {
      load: () => Promise.resolve(structuredClone(initial)),
      save: () => Promise.resolve(),
    };
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition(), persistence }), { actor, auto_autosave: false });
    expect(await runtime.boot()).toMatchObject({ ok: true });
    expect(runtime.state.current_branch_id).toBe("branch:main");
    expect(await runtime.create_template({ key: "global", name: "Global", branch_id: null, published: false, field: { id: "g", type: "text", label: "G" }, meta: {} })).toMatchObject({ ok: true, value: { branch_id: null } });
  });

  it("moves a template between branch and global scope without stale cached views", async () => {
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false }); await runtime.boot();
    const saved = await runtime.create_template({ key: "movable", name: "Movable", branch_id: "main", published: false, field: { id: "m", type: "text", label: "M" }, meta: {} });
    expect(saved.ok).toBe(true); if (!saved.ok) return;
    expect(await runtime.create_branch("Feature")).toMatchObject({ ok: true });
    const branchId = runtime.state.current_branch_id as string;
    expect(runtime.state.templates.map((item) => item.key)).toEqual([]);
    expect(await runtime.switch_branch("main")).toMatchObject({ ok: true });
    expect(await runtime.update_template(saved.value.id, { branch_id: null })).toMatchObject({ ok: true, value: { branch_id: null } });
    expect(await runtime.switch_branch(branchId)).toMatchObject({ ok: true });
    expect(runtime.state.templates.map((item) => item.key)).toEqual(["movable"]);
    expect(await runtime.update_template(saved.value.id, { branch_id: branchId })).toMatchObject({ ok: true, value: { branch_id: branchId } });
    expect(await runtime.switch_branch("main")).toMatchObject({ ok: true });
    expect(runtime.state.templates).toEqual([]);
  });

  it("enforces template capture and insertion permissions through the runtime", async () => {
    const permissive = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false }); await permissive.boot();
    const template: FieldTemplate = { id: "saved", key: "saved", name: "Saved", branch_id: "main", published: false, field: { id: "x", type: "text", label: "X" }, updated_at: new Date(0).toISOString(), meta: {} };
    const backend = new MemoryWorkspaceBackend({ definition: definition(), permissions: { ...permissive.state.permissions, "document.mutate": false, "template.write": false } });
    expect(await backend.save_template(template)).toMatchObject({ ok: true });
    const runtime = new WorkspaceRuntime(backend, { actor, auto_autosave: false }); await runtime.boot();
    expect(runtime.capture_field_template("x")).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
    expect(runtime.instantiate_template(template.id)).toMatchObject({ ok: false, error: { code: "authorization_denied" } });
    expect(runtime.state.definition?.fields).toEqual([]);
  });

  it("does not show a private template on a different branch when its save resolves late", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    class DelayedTemplateBackend extends MemoryWorkspaceBackend {
      override async save_template(template: FieldTemplate) { await gate; return super.save_template(template); }
    }
    const runtime = new WorkspaceRuntime(new DelayedTemplateBackend({ definition: definition() }), { actor, auto_autosave: false }); await runtime.boot();
    const saving = runtime.create_template({ key: "main-only", name: "Main", branch_id: "main", published: false, field: { id: "main-only", type: "text", label: "Main" }, meta: {} });
    expect(await runtime.create_branch("Feature")).toMatchObject({ ok: true });
    release?.(); expect(await saving).toMatchObject({ ok: true });
    expect(runtime.state.templates.map((item) => item.key)).toEqual([]);
    expect(await runtime.switch_branch("main")).toMatchObject({ ok: true });
    expect(runtime.state.templates.map((item) => item.key)).toEqual(["main-only"]);
  });

  it("rejects invalid template references without changing the document", async () => {
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition() }), { actor, auto_autosave: false }); await runtime.boot();
    const saved = await runtime.create_template({
      key: "broken", name: "Broken", branch_id: "main", published: false,
      field: { id: "field", type: "text", label: "Field" },
      relationships: { includes_for_buttons: { field: ["missing"] }, excludes_for_buttons: {}, option_effects_for_buttons: {}, value_effects_for_triggers: {} }, meta: {},
    });
    expect(saved.ok).toBe(true); if (!saved.ok) return;
    expect(runtime.instantiate_template(saved.value.id)).toMatchObject({ ok: false, error: { code: "template_invalid" } });
    expect(runtime.state.definition?.fields).toEqual([]);
    expect(runtime.editor?.can_undo()).toBe(false);
  });

  it("captures a cyclic relationship group and remaps option selections for their target field", async () => {
    const product = definition();
    product.fields = [
      { id: "trigger", type: "button", label: "Trigger", button: true, bind_id: "root" },
      { id: "target", type: "select", label: "Target", bind_id: "root", options: [{ id: "option", label: "Option" }] },
      { id: "unrelated", type: "text", label: "Unrelated", bind_id: "root" },
    ];
    product.includes_for_buttons = { trigger: ["target"] };
    product.excludes_for_buttons = { target: ["trigger"] };
    product.option_effects_for_buttons = { trigger: { target: { include: ["option"] } } };
    product.value_effects_for_triggers = { trigger: { target: { value: "option" } } };
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: product }), { actor, auto_autosave: false }); await runtime.boot();
    const captured = runtime.capture_field_template("trigger", true);
    expect(captured.ok).toBe(true); if (!captured.ok) return;
    expect(captured.value.connected_fields?.map((field) => field.id)).toEqual(["target"]);
    expect(captured.value.relationships?.option_effects_for_buttons.trigger?.target?.include).toEqual(["option"]);
    const saved = await runtime.create_template({ key: "group", name: "Group", branch_id: "main", published: false, ...captured.value, meta: {} });
    expect(saved.ok).toBe(true); if (!saved.ok) return;
    const inserted = runtime.instantiate_template(saved.value.id, { bind_id: "root" });
    expect(inserted.ok).toBe(true); if (!inserted.ok) return;
    const ids = inserted.value.id_map; const document = runtime.state.definition as ProductDefinition;
    expect(document.includes_for_buttons[ids.trigger as string]).toEqual([ids.target]);
    expect(document.excludes_for_buttons[ids.target as string]).toEqual([ids.trigger]);
    expect(document.option_effects_for_buttons[ids.trigger as string]?.[ids.target as string]?.include).toEqual([ids.option]);
    expect(document.value_effects_for_triggers[ids.trigger as string]?.[ids.target as string]?.value).toBe(ids.option);
    expect(document.fields.some((field) => field.id === "unrelated-copy")).toBe(false);
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
