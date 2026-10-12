#!/bin/sh

project_root="$(git rev-parse --show-toplevel)"
required_node_version="$(tr -d '[:space:]' < "$project_root/.nvmrc")"

node_meets_requirement() {
  node -e '
    const currentVersion = process.versions.node.split(".").map(Number);
    const minimumVersion = [22, 14, 0];
    const isSupported = currentVersion.some(
      (versionPart, versionIndex) =>
        versionPart > minimumVersion[versionIndex] &&
        currentVersion.slice(0, versionIndex).every(
          (currentPart, currentIndex) => currentPart === minimumVersion[currentIndex],
        ),
    ) || currentVersion.every(
      (versionPart, versionIndex) => versionPart >= minimumVersion[versionIndex],
    );
    process.exit(isSupported ? 0 : 1);
  ' >/dev/null 2>&1
}

use_node_directory() {
  node_directory="$1"
  if [ -x "$node_directory/node" ]; then
    PATH="$node_directory:$PATH"
    export PATH
  fi
}

if ! command -v node >/dev/null 2>&1 || ! node_meets_requirement; then
  use_node_directory "/opt/homebrew/opt/node@22/bin"
  use_node_directory "/usr/local/opt/node@22/bin"
fi

if ! command -v node >/dev/null 2>&1 || ! node_meets_requirement; then
  nvm_directory="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_directory/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$nvm_directory/nvm.sh"
    nvm use --silent "$required_node_version" >/dev/null 2>&1 || true
  fi
fi

if (! command -v node >/dev/null 2>&1 || ! node_meets_requirement) && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --shell bash)"
  fnm use "$required_node_version" --silent-if-unchanged >/dev/null 2>&1 || true
fi

if (! command -v node >/dev/null 2>&1 || ! node_meets_requirement) && command -v mise >/dev/null 2>&1; then
  mise_node="$(mise which "node@$required_node_version" 2>/dev/null || true)"
  if [ -n "$mise_node" ]; then
    use_node_directory "$(dirname "$mise_node")"
  fi
fi

if (! command -v node >/dev/null 2>&1 || ! node_meets_requirement) && command -v asdf >/dev/null 2>&1; then
  asdf_node_root="$(asdf where nodejs "$required_node_version" 2>/dev/null || true)"
  if [ -n "$asdf_node_root" ]; then
    use_node_directory "$asdf_node_root/bin"
  fi
fi

if (! command -v node >/dev/null 2>&1 || ! node_meets_requirement) && command -v volta >/dev/null 2>&1; then
  volta_node="$(volta which node 2>/dev/null || true)"
  if [ -n "$volta_node" ]; then
    use_node_directory "$(dirname "$volta_node")"
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! node_meets_requirement; then
  printf '\033[31m✖ Node.js 22.14 or newer is required. Install %s with NVM, fnm, mise, asdf, Volta, or Homebrew.\033[0m\n' "$required_node_version" >&2
  return 1 2>/dev/null || exit 1
fi
