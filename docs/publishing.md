# Publishing research and release procedure

Research checked on 2026-09-08 against installed Pi 0.85.0 documentation,
the Pi package catalog, devenv documentation, and npm documentation.

## What the Pi extension repository means

Pi distributes extensions as **Pi packages** through npm or Git. The official
[package catalog](https://pi.dev/packages) indexes npm packages carrying the
`pi-package` keyword. The documented route is npm publication, not a pull request
adding extension source to Pi's core repository. A GitHub repository alone supports
Git installs but does not replace npm publication for catalog discovery.

The package needs:

- `package.json` with a unique npm name, version, description, license, and repository URL.
- `keywords` containing `pi-package`.
- `pi.extensions` pointing to entry points included in the published package.
- A default-exported factory receiving `ExtensionAPI`.
- Runtime dependencies in `dependencies`, because Pi can install with `--omit=dev`.

Pi uses jiti to load TypeScript. Compilation and bundling are not required.
This repository ships `src/index.ts` directly and tests the package file list before publishing.
Do not add `prepare` or installation hooks that require development dependencies.

Core Pi imports belong in `peerDependencies` with `"*"`, per Pi's package docs.
The current namespace is `@earendil-works`; older examples use `@mariozechner`.
This project tests against `@earendil-works/pi-coding-agent@0.85.0`, matching the
installed agent. npm reported 0.85.1 as latest during setup. The optional peer
prevents npm from installing another Pi CLI solely for a type-only import.
The wildcard follows packaging guidance; it is not a claim that every Pi version was tested.

The npm-published Pi 0.85.0 CLI imports `@earendil-works/pi-server` without declaring
it as a dependency. A pinned development dependency supplies the missing package.
The packed extension smoke test catches CLI startup failures as well as extension
loading errors. Remove the workaround only after upgrading Pi and passing that test.

`pi.image` or `pi.video` can provide a catalog preview later. A preview is optional.
No indexing delay or immediate listing is guaranteed by the reviewed documentation.

## Repository and environment decisions

GitHub repository: `fazekasda/pi-kiwifs-memory`, public, MIT license.
Intended npm package: `@fazekasda/pi-kiwifs-memory`.
GitHub identity does not prove ownership of the same npm scope.

Use native devenv configuration rather than maintaining a second flake:

- `devenv.yaml` declares the nixpkgs input.
- `devenv.lock` records resolved Nix input revisions and hashes.
- `devenv.nix` selects Node.js 24 and repository tooling.
- `.envrc` uses `eval "$(devenv direnvrc)"` followed by `use devenv`.
- `package-lock.json` records npm dependency versions and integrity hashes.

Nix pins tools; npm pins dependencies. The npm installation is not a sandboxed
Nix build and can need network access. `direnv allow` approves this checkout's
shell configuration. No global Nix or shell configuration is modified by this repo.

CI tests Node 22.19.0 and Node 24, then separately runs `devenv test` on Linux.
Action references use commit SHAs. Dependabot proposes npm and action updates.
Update Nix inputs deliberately with `devenv update`, run `devenv test`, then commit
the changed lockfile. Keep the devenv CLI version in CI and README aligned.

## Before the first release

1. Implement and test the intended memory behavior. The current version is only a scaffold.
2. Confirm npm account ownership of the `@fazekasda` scope and check name availability.
3. Enable npm two-factor authentication.
4. Run `devenv test` and review `npm run pack:check` output.
5. Run `npm pack`, inspect the resulting `.tgz`, and test the shipped extension in Pi.
6. Confirm `package.json` version, repository URL, license, README, and release notes.
7. Configure the GitHub `npm` environment with required reviewers if approval is wanted.

The publish job targets the `npm` environment. Merely naming an environment in YAML
does not configure approval rules. Add those rules in GitHub repository settings.

## First npm publication

A new package may need an initial interactive publication before its npm package
settings expose trusted publishing. Do not put an npm token in Git or CI.
From the reviewed release commit:

```sh
npm login
npm whoami
npm publish --access public
```

Complete npm's interactive authentication and 2FA prompts. `prepublishOnly` runs
checks first, including a packed-extension RPC smoke test with isolated settings
and no provider credentials. The smoke test requires `tar`, provided by the Nix
shell and Linux CI runners. This publication was not performed during scaffold setup.

After initial publication, create its matching Git tag if needed, but do not publish
a GitHub release for that already-published version with the automated job enabled.
npm rejects publishing the same version twice.

## Configure trusted publishing for later releases

In the npm package settings, add a GitHub Actions trusted publisher:

- Organization or user: `fazekasda`
- Repository: `pi-kiwifs-memory`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allow direct `npm publish` if the settings offer allowed actions.

The workflow uses a GitHub-hosted runner, Node 24, npm >=11.5.1, and
`id-token: write`. It uses short-lived OpenID Connect credentials rather than
`NPM_TOKEN`. The public repository URL in `package.json` must match GitHub.
Provenance requires a public source repository and public npm package.

After a successful trusted publication, consider npm's setting to require 2FA and
disallow traditional publish tokens. Revoke obsolete automation tokens separately.

## Later releases

On a clean, reviewed `main` branch, choose the next version:

```sh
npm version patch
# npm version updates both npm manifests, commits, and creates a v-prefixed tag.
git push origin main
git push origin v0.1.1
```

Replace `v0.1.1` with the version you just created. Wait for main-branch CI to pass,
then create a GitHub release for that tag:

```sh
gh release create v0.1.1 --verify-tag --generate-notes
```

Publishing a non-prerelease GitHub release triggers `publish.yml`. The job verifies
that its tag equals `v` plus `package.json` version, installs locked dependencies,
and runs `npm publish --access public --provenance`. npm runs `prepublishOnly`,
which checks types, formatting, tests, and package contents.

The workflow skips GitHub prereleases. Add an explicit npm dist-tag policy before
supporting prerelease publication. A push to `main` alone never publishes to npm.

After publication, verify:

```sh
npm view @fazekasda/pi-kiwifs-memory version
pi install npm:@fazekasda/pi-kiwifs-memory
```

Check the [Pi catalog](https://pi.dev/packages) for indexing.
Consumers can pin an npm version or Git tag:

```sh
pi install npm:@fazekasda/pi-kiwifs-memory@0.1.1
pi install git:github.com/fazekasda/pi-kiwifs-memory@v0.1.1
```

## Sources

- [Pi package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md): manifests, dependencies, npm/Git installs, catalog metadata.
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md): factory entry point, TypeScript loading, lifecycle, UI guards.
- [Pi catalog](https://pi.dev/packages): published package discovery and install commands.
- [devenv direnv integration](https://devenv.sh/integrations/direnv/): `.envrc` setup and approval.
- [devenv JavaScript options](https://devenv.sh/languages/javascript/): Node selection and explicit npm installation.
- [devenv GitHub Actions](https://devenv.sh/integrations/github-actions/): CI shell and `devenv test`.
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/): OIDC requirements, package settings, provenance, and permission limits.
