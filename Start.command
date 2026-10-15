#!/bin/zsh
cd "$(dirname "$0")" || exit 1
deck_node="$(command -v node)"
# Finder doesn't load your shell profile: also look in Homebrew and the newest nvm install.
for candidate in /opt/homebrew/bin/node /usr/local/bin/node $HOME/.nvm/versions/node/*/bin/node(NOn[1]); do
  [[ -x "$deck_node" ]] && break
  deck_node="$candidate"
done
if [[ ! -x "$deck_node" ]]; then
  print "Node.js not found on this Mac. Install it from https://nodejs.org"
  read -r
  exit 1
fi
"$deck_node" server.js
read -r
