# DGP Workspace

DGP Workspace provides reusable editorial infrastructure for authoring, validating, reviewing, and publishing Digital Goods Protocol product definitions. It is a package for host applications and the future DGP Studio; it is not itself the Studio application.

## Responsibilities

- Editorial canvas and adapters
- Definition diagnostics and publication readiness
- Service, capability, policy, and fallback editing
- Templates, comments, authors, and permissions
- Branches, drafts, commits, and publication workflows
- Persistence and live-collaboration adapter contracts

Customer ordering belongs to DGP Ordering. Runtime interpretation belongs to DGP Core. Backend fulfillment belongs to the DGP SDK.

## Ecosystem

- [DGP Spec](https://github.com/elqora/dgp-spec) owns canonical contracts.
- [DGP Core](https://github.com/elqora/dgp-core) interprets definitions.
- [DGP Validation](https://github.com/elqora/dgp-validation) supplies reusable diagnostics.
- [DGP Ordering](https://github.com/elqora/dgp-ordering) renders customer ordering experiences.
- [DGP SDK](https://github.com/elqora/dgp-sdk) defines backend execution.
- [Digital Service Engine](https://github.com/timeax/digital-service-engine) is the legacy migration source and behavioral reference.

## Status

Repository scaffold only. Workspace extraction and migration will be planned separately.

## License

GPL-3.0.
