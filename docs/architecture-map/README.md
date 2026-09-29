# Architecture map

Desktop structure maps built with the DEX OpenZeppelin components and React Flow.
Hover or focus a box or a choice row to read its documentation.

The Backend view separates the Fastify HTTP entry point from `main.ts` application
assembly. HTTP requests enter at the router; background workers call workflows without it.
Fastify dispatches to module handlers. IAM is its shared `onRequest` authentication hook.
Activity reads persisted history through the domain stores; its read-only workflow
wrappers are explained in the source hover, without arrows suggesting trade execution.

The DEX app shows the map under Dev -> Docs -> Architecture Atlas.
The normal frontend commands generate its content:

```sh
npm run dev --prefix frontend
npm run build --prefix frontend
```

Open `http://localhost:5180/#/dev/docs/architecture/system`.
`npm run architecture:content --prefix frontend` regenerates the content without Vite.

Edit module descriptions in the bound TypeScript files: a brief TSDoc summary,
optional `@remarks`, and `@packageDocumentation`. The map reads those comments;
it does not execute the modules. [TSDoc summary and remarks](https://tsdoc.org/pages/tags/remarks/).

`documentationSources` in [model.cjs](model.cjs) binds each module to its source.
Bindings may target a module header or a named declaration, such as `SwapStore`.
Descriptions update automatically in `dev` and `dev:keycloak` and regenerate at build time.
Missing or ambiguous documentation fails generation; `@privateRemarks` is excluded.
Run `npm run test:architecture-docs --prefix frontend` to check extraction.

Edit [model.cjs](model.cjs) for entities, choices and layer membership.
Contract/runtime explanations remain in this model; TSDoc documents TS modules.
[verify.cjs](verify.cjs) validates sources, choice anchors and layer membership before generation.
The viewer lives in `frontend/src/features/docs/architecture/`; its `graph-*.ts` files define each
view's boxes and connections.
Views: All Layers, Frontend, Client, Backend and Contracts. Canton has no view; All Layers shows its runtime as context.
Do not edit `model.generated.json` directly.
Business flows live only in [docs/flows](../flows/): each `.puml` is the source of its diagram
on the Daml flows page (Dev -> Docs -> Daml flows). The Atlas shows structure, not flows.

Tooltips show source file paths and line numbers. TSDoc references are extracted
from the current local files.
Content checks do not establish runtime behavior.
