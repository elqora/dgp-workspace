// SPDX-License-Identifier: GPL-3.0-only

import type { ProductDefinition } from "@elqora/dgp-spec";
import { describe, expect, it } from "vitest";

import {
  MemoryWorkspaceBackend,
  WorkspaceRuntime,
  createManualWorkspaceLiveAdapter,
  type CommentThread,
  type FieldTemplate,
  type WorkspacePermissions,
  type SaveDraftInput,
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

  it("accepts host authorization decisions without defining presentation", async () => {
    const permissions = Object.fromEntries([
      "document.mutate", "draft.save", "commit.create", "publish", "branch.create",
      "branch.merge", "branch.delete", "template.write", "comment.write",
    ].map((action) => [action, action !== "publish"])) as WorkspacePermissions;
    const runtime = new WorkspaceRuntime(new MemoryWorkspaceBackend({ definition: definition(), permissions }), { actor });
    await runtime.boot();
    expect(await runtime.publish()).toMatchObject({ ok: false, error: { code: "authorization_denied", meta: { action: "publish" } } });
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
});
