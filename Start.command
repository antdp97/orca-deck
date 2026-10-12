#!/bin/zsh
cd "$(dirname "$0")" || exit 1
deck_node="$(command -v node)"
if [[ -z "$deck_node" ]]; then
  deck_node="/Users/andy/.nvm/versions/node/v24.18.0/bin/node"
fi
if [[ ! -x "$deck_node" ]]; then
  print "Không tìm thấy Node.js trên Mac."
  read -r
  exit 1
fi
"$deck_node" server.js
read -r
