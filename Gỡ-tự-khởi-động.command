#!/bin/zsh
cd "$(dirname "$0")" || exit 1
/usr/bin/python3 install-autostart.py --uninstall
read -r
