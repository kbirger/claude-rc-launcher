# GitHub management and roles: ideas

Date: 2026-11-15. Status: idea only. Nothing is built. This is not a spec. The owner chose to leave it for a later task.

## Why

The role design in `docs/auth-architecture.md` gives every hub route a minimum role. GitHub support already exists, and a fine-grained rule for it needs more thought. The owner chose to postpone that thought.

## How it works today

This section comes from reading the code.

- A node runs `gh` as the service user. `POST /github/login` starts the `gh` device login and stores a token in the home folder of that user. `GET /github/login/:id` reports the progress.
- `GET /github/repos` lists the repositories that this token can reach. `POST /clone` clones a repository with the same token through the `gh` credential helper.
- The three routes live in `server/src/app.ts` on the node. The hub forwards them in `server/src/hosts/api/forward.ts`. The cloning code is in `server/src/instances/cloner.ts`.
- Each route takes an optional `user` field that names the service user. `POST /fs/mkdir` takes the same field.

## Rules decided for the role phase

- `POST /github/login` and `GET /github/login/:id` need admin. They replace a stored credential.
- `GET /github/repos` and `POST /clone` need write. A clone makes a folder with data that the node can already reach through its own login. It is the same kind of action as making a folder.
- A request that names a `user` other than the default `service_user` of the node needs admin. The same rule applies to a new instance and to `POST /fs/mkdir`.

This task covers only the finer rules that are still open.

## Things to settle

- The token scope is the real limit. A write user can list private repository names and clone anything that the token reaches. Open question: can the login use a narrower scope than the `repo` scope that it asks for today?
- Open question: can a write user clone only from a list of allowed owners or organizations?
- Open question: what does a user below admin see on the web page? The choices are a hidden button, or a message such as "Ask an admin to log in to GitHub".
- Open question: does the hub write an audit line for each clone, with the user, the role, and the repository?
- Open question: does each person need their own GitHub login, so that a clone uses their own account? The current design shares one token for each service user.
