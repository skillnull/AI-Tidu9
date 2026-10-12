#!/bin/sh

project_root="$(git rev-parse --show-toplevel)"
required_node_version="$(tr -d '[:space:]' < "$project_root/.nvmrc")"

node_meets_requirement() {
  node -e '
    const current = process.versions.node.split(".").map(Number);
    const minimum = [22, 14, 0];
    process.exit(current.some((part, index) => part > minimum[index] && current.slice(0, index).every((value, offset) => value === minimum[offset])) || current.every((part, index) => part >= minimum[index]) ? 0 : 1);
  ' >/dev/null 2>&1
}

if ! command -v node >/dev/null 2>&1 || ! node_meets_requirement; then
  nvm_directory="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$nvm_directory/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$nvm_directory/nvm.sh"
    nvm use --silent "$required_node_version" >/dev/null
  fi
fi

if ! command -v node >/dev/null 2>&1 || ! node_meets_requirement; then
  printf '\033[31m✖ Node.js %s or newer is required. Run: nvm install && nvm use\033[0m\n' "$required_node_version" >&2
  exit 1
fi
