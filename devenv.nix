{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    npm.enable = true;
    # Dependency installation stays explicit: shell entry never runs npm scripts.
    npm.install.enable = false;
  };

  packages = with pkgs; [
    git
    gh
    direnv
    jq
    ripgrep
    nixfmt
    shellcheck
    actionlint
  ];

  scripts.repo-check.exec = ''
    set -euo pipefail
    npm run check
    npm run pack:check
    nixfmt --check devenv.nix
    shellcheck .envrc
    actionlint
  '';

  enterShell = ''
    echo "pi-kiwifs-memory: npm ci, npm run dev, repo-check"
  '';

  enterTest = ''
    set -euo pipefail
    npm ci
    repo-check
  '';
}
