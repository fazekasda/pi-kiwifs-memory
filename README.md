# pi-kiwifs-memory

Development scaffold for a KiwiFS memory extension for [Pi](https://pi.dev).

Only `/kiwifs-status` exists today. It reports that the extension loaded.
Memory storage, retrieval, and KiwiFS integration are not implemented.
The command makes no network requests and writes no files.

## Development

Install [Nix](https://nixos.org/download/), [devenv](https://devenv.sh/getting-started/),
and [direnv](https://direnv.net/docs/installation.html).
Use devenv 1.8.2, matching CI. Enable the
[direnv shell hook](https://direnv.net/docs/hook.html) once in your shell configuration.
These tools are already installed on the original development machine.

```sh
git clone https://github.com/fazekasda/pi-kiwifs-memory.git
cd pi-kiwifs-memory
direnv allow
npm ci
npm run dev
```

Run `/kiwifs-status` in Pi. Restart `npm run dev` after editing the source.
`npm run dev` uses the Pi CLI installed in `node_modules`, pinned to 0.85.0.
Provider login is only needed for model requests, not extension status.
A pinned development dependency on `@earendil-works/pi-server` works around
Pi 0.85.0's missing CLI dependency; the extension itself does not use the server.

Without direnv:

```sh
devenv shell
npm ci
npm run dev
```

`devenv.nix` selects Node.js 24 and provides npm, Git, GitHub CLI, jq,
ripgrep, nixfmt, ShellCheck, and actionlint. `devenv.lock` pins Nix inputs;
`package-lock.json` pins npm dependencies. Shell entry does not install npm packages.
No separate `flake.nix` is needed: devenv manages the Nix environment.

```sh
repo-check            # TypeScript, formatting, tests, package contents, Nix/shell/CI lint
npm run test:watch
npm run format        # Format TypeScript, JSON, YAML, Markdown
nixfmt devenv.nix
```

`devenv test` installs locked npm dependencies and runs `repo-check`.
Outside Nix, Node.js >=22.19.0 can run `npm ci`, `npm run check`, and `npm run pack:check`.

For hot reload, install this checkout as a local Pi package:

```sh
pi install /absolute/path/to/pi-kiwifs-memory
```

Start Pi, edit source, then run `/reload`. Remove the local installation when done:

```sh
pi remove /absolute/path/to/pi-kiwifs-memory
```

Do not also use `-e` while the same extension is installed locally.

## Install from GitHub

With Pi already installed:

```sh
pi install git:github.com/fazekasda/pi-kiwifs-memory
```

This installs the current development scaffold. For a future tagged release,
append `@v0.1.0` once that tag exists.

After the first npm release, installation will also work with:

```sh
pi install npm:@fazekasda/pi-kiwifs-memory
```

The scaffold setup does not publish an npm release.

## Layout

- `src/index.ts`: Pi extension entry point and status command.
- `test/extension.test.ts`: command registration, UI, and headless tests.
- `scripts/check-package.mjs`: verifies the npm package file allowlist.
- `scripts/smoke-package.mjs`: loads the packed extension in isolated Pi RPC and runs its command.
- `devenv.nix`, `devenv.yaml`, `.envrc`: Nix development environment.
- `.github/workflows/ci.yml`: Node compatibility and Nix checks.
- `.github/workflows/publish.yml`: release-triggered npm trusted publishing.
- [Publishing research and release steps](docs/publishing.md).

Pi loads TypeScript directly, so releases ship `src/`, not a compiled bundle.
Runtime dependencies must go in `dependencies`; development tools belong in
`devDependencies`. Pi supplies its own core packages at runtime.

## Safety

Pi extensions run with your full user permissions. Review extensions before installing them.
Nix and devenv provide development tools, not a sandbox for extension execution.
Do not commit credentials, Pi session history, or memory data. `.pi/`, `.env*`,
and `.npmrc` are ignored; npm publishes only the file allowlist in `package.json`.

## License

[MIT](LICENSE).
