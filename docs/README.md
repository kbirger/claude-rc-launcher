# Documentation

These pages explain how to install, configure and use Claude RC Launcher. Start with the [README](../README.md) for an overview.

## Use it

- [Using the web UI](web-ui.md): instances, the New dialog, clone, settings, sessions and files, permissions, nodes, updates and appearance.
- [Command-line client](cli.md): every `claude-rc` command and flag.
- [Updates](updates.md): version checks and updates of the hub, the nodes and the clients.

## Set it up

- [Install](install.md): the Linux hub, the systemd service and the Windows node.
- [Configuration](configuration.md): every key of `config.toml`, trusted folders, user scope and the generated unit.
- [Authentication](authentication.md): OIDC for any provider, roles, CLI login, forward auth with a signed JWT, and the authentik setup script.
- [Multiple hosts](multi-host.md): nodes, pairing, shared secrets, hub keys and key rotation.
- [SSH delegation](ssh-delegation.md): let a session reach another machine over SSH, with an approval on your phone for each grant.
- [Reverse proxy](reverse-proxy.md): nginx and Traefik examples.
- [Security](security.md): what a login gives, and the security model between the hub and the nodes.

## Reference

- [HTTP API](api.md): the routes of the hub and the nodes.
- [Authentication and authorization architecture](auth-architecture.md): the design of login and roles, with diagrams.
- [How session files work](session-files.md): the code behind the session file screens.
- [Development](development.md): build, test, release and the first-run checklist.
