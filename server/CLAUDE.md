# Summary
Bun.JS backend application. Strongly prefer an object oriented style, with use of SOLID principles.

## Source layout

Group server code by feature, not by kind of file. A feature is one thing the product does, such as SSH access, sessions or updates. Each feature has one folder in `server/src/`. Do not put the routes, services or stores of different features in one folder.

Inside a feature folder:

- `api/` holds the route files. A route file parses a request, calls one method of a service and maps the result to a status. It holds no business logic.
- The service classes, the stores and the domain types sit in the feature folder. When a feature has more than one part of the system, use a subfolder named after the part, such as `hub/` and `node/`.
- Platform code that differs by operating system sits behind an interface, in its own folder or files.
- `index.ts` lists what other features may import.

These files stay at the top of `server/src/`:

- The entry points `index.ts`, `index.win.ts`, `hubmain.ts` and `nodemain.ts`, and `app.ts`, which mounts the routers. Together they are the composition root.
- `roles.ts` and `serve.ts`. Many features use them, so they are in no feature.

`win/` is a platform folder, not a feature. It holds the code that runs only on Windows. It has no `index.ts`: a feature imports a `win/` file directly.

When you add a file, look for its feature folder first. Create a new feature folder only for a new feature.

## File names

- A file holds one main class. Name the file after the class, in PascalCase: `SshTargetService.ts` holds `SshTargetService`. A small type, an error type or an options type for that class may stay in the same file.
- If a file needs two classes, make two files.
- A file with no class is named for what it holds, in lowercase: `addresses.ts`, `grammar.ts`. One function that serves one class stays in that class file.
- These generic names are allowed: `index.ts`, `types.ts`, `errors.ts` and `constants.ts`. A feature folder has at most one of each.
- Do not name a file `helpers`, `utils`, `common` or `misc`. Name it for what it does, and put it in the feature that uses it.

## Imports

- `api/` can import services. A service must never import `api/`. Only the `api/` folder of the same feature and the composition root import an `api/` file.
- A feature imports another feature only through its `index.ts`. `win/`, `roles.ts` and `serve.ts` also import a feature only through its `index.ts`. The composition root and the tests are exempt. `cli/` is a separate package, and these rules do not apply to it.
- `shared/` never imports a feature.
- Hub-only code never imports node-only code, and node-only code never imports hub-only code. In `ssh/`, this means `hub/` and `node/`.

Put code in `shared/` only when two features need it and it knows nothing about either of them.

`eslint.config.js` checks the import rules and the main file name rules. In the lint, `shared/` imports nothing outside `shared/`. The lint also stops import cycles with `import-x/no-cycle`. That rule ignores type-only imports. The config lists three exceptions, each with its reason.

## Tests

Tests live in `server/test/`, in the same folder layout as `server/src/`. A test file has the name of the file it tests, with `.test.ts` added.

## Existing code

The files in `server/src/` follow this layout. When you move or add a file, keep to it. Do not start a partial move on your own. A planned move updates all the files of one feature at once.
