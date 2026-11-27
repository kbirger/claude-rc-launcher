# Summary
Bun.JS backend application. Strongly prefer an object oriented style, with use of SOLID principles.

## Source layout

Group server code by feature, not by kind of file. A feature is one thing the product does, such as SSH access, sessions or updates. Each feature has one folder in `server/src/`. Do not put the routes, services or stores of different features in one folder.

Inside a feature folder:

- `api/` holds the route files. A route file parses a request, calls one method of a service and maps the result to a status. It holds no business logic.
- The service classes, the stores and the domain types sit in the feature folder. When a feature has more than one part of the system, use a subfolder named after the part, such as `hub/` and `node/`.
- Platform code that differs by operating system sits behind an interface, in its own folder or files.
- `index.ts` lists what other features may import.

Entry points (`index.ts`, `index.win.ts`, `hubmain.ts`, `nodemain.ts`) and `app.ts`, which mounts the routers, stay at the top of `server/src/`. When you add a file, look for its feature folder first. Create a new feature folder only for a new feature.

## File names

- A file holds one main class. Name the file after the class, in PascalCase: `SshTargetService.ts` holds `SshTargetService`. A small type, an error type or an options type for that class may stay in the same file.
- If a file needs two classes, make two files.
- A file with no class is named for what it holds, in lowercase: `addresses.ts`, `grammar.ts`. One function that serves one class stays in that class file.
- These generic names are allowed: `index.ts`, `types.ts`, `errors.ts` and `constants.ts`. A feature folder has at most one of each.
- Do not name a file `helpers`, `utils`, `common` or `misc`. Name it for what it does, and put it in the feature that uses it.

## Imports

- `api/` may import services. A service must never import `api/`.
- A feature may import another feature only through its `index.ts`.
- `shared/` never imports a feature.
- Hub-only code never imports node-only code, and node-only code never imports hub-only code.

Put code in `shared/` only when two features need it and it knows nothing about either of them.

## Tests

Tests live in `server/test/`, in the same folder layout as `server/src/`. A test file has the name of the file it tests, with `.test.ts` added.

## Existing code

The current files in `server/src/` are flat and do not follow this layout yet. When you move or add a file, follow the layout above. Do not start a partial move on your own. A planned move updates all the files of one feature at once.
