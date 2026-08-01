# Agent guidance: DGP Workspace

Read and follow `../AGENTS.md` before working in this repository.

## Role

This repository supplies reusable editorial infrastructure. A future `dgp-studio` application may consume it, but application-specific product decisions do not belong here.

## Dependencies

- May depend on sibling `dgp-spec`, `dgp-core`, and `dgp-validation`.
- Must not become a dependency of `dgp-core` or `dgp-ordering`.
- Keep host persistence, transport, and live collaboration behind adapters.

## Boundaries

- Own authoring, diagnostics, collaboration, drafts, branches, and publication workflows.
- Do not own customer ordering or backend fulfillment.
- Treat service `meta` as host-defined `Record<string, any>` and do not impose a canonical structure.

## References

- Legacy editorial sources: `D:\Projects\GitHub\digital-service-ui-builder\src\react\canvas`, `src\react\workspace`, and `src\react\fallback-editor`.
- Backend reference: `D:\Projects\GitHub\elqora\dgp-sdk` and sibling `dgp-sdk`.
- Sibling repositories: `dgp-spec`, `dgp-core`, `dgp-validation`, and `dgp-ordering`.
