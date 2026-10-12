#!/usr/bin/python3
"""Add/remove only this hook, preserving the user's existing Claude settings."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--settings', type=Path, default=Path.home() / '.claude' / 'settings.json')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    command = '/usr/bin/python3 ' + shlex.quote(str(root / 'hook.py'))
    settings_path = args.settings
    if settings_path.is_symlink():
        raise SystemExit('settings.json là symlink; cần dùng --settings với file đích.')
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    before = json.dumps(settings, sort_keys=True)
    hooks = settings.setdefault('hooks', {})
    entries = hooks.setdefault('PermissionRequest', [])
    if args.uninstall:
        kept = []
        for entry in entries:
            remaining = [h for h in entry.get('hooks', []) if h.get('command') != command]
            if remaining:
                kept.append(dict(entry, hooks=remaining))
        if kept:
            hooks['PermissionRequest'] = kept
        else:
            hooks.pop('PermissionRequest', None)
        if not hooks:
            settings.pop('hooks', None)
    elif not any(h.get('command') == command for entry in entries for h in entry.get('hooks', [])):
        entries.append({'matcher': '*', 'hooks': [{'type': 'command', 'command': command, 'timeout': 190}]})
    if json.dumps(settings, sort_keys=True) == before:
        print('Cấu hình đã đúng; không thay đổi.')
        return
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    mode = stat.S_IMODE(settings_path.stat().st_mode) if settings_path.exists() else 0o600
    if settings_path.exists():
        backup = settings_path.with_name(settings_path.name + '.orca-deck-backup-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
        shutil.copy2(settings_path, backup)
        os.chmod(backup, 0o600)
        print('Đã sao lưu: ' + str(backup))
    fd, name = tempfile.mkstemp(prefix='.orca-deck-', dir=str(settings_path.parent))
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(settings, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
        os.chmod(name, mode)
        os.replace(name, settings_path)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print('Đã gỡ hook Orca Deck.' if args.uninstall else 'Đã thêm hook Orca Deck; giữ nguyên các hook có sẵn.')


if __name__ == '__main__':
    main()
