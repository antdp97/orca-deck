#!/usr/bin/python3
"""Install/remove a LaunchAgent that starts Orca Deck at login and restarts it if it stops."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

LABEL = 'com.orcadeck.server'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--agents-dir', type=Path, default=Path.home() / 'Library' / 'LaunchAgents')
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--no-launchctl', action='store_true', help='only write/remove the file (tests)')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    plist = args.agents_dir / (LABEL + '.plist')
    domain = 'gui/%d' % os.getuid()

    def launchctl(*command):
        if args.no_launchctl:
            return 0
        return subprocess.run(['/bin/launchctl', *command], capture_output=True).returncode

    if args.uninstall:
        launchctl('bootout', domain + '/' + LABEL)
        plist.unlink(missing_ok=True)
        print('Đã tắt tự khởi động Orca Deck.')
        return
    if not args.node or not os.access(args.node, os.X_OK):
        raise SystemExit('Không tìm thấy Node.js. Chạy lại với --node /đường/dẫn/node.')
    node = os.path.abspath(args.node)
    log = root / '.local' / 'deck.log'
    log.parent.mkdir(mode=0o700, exist_ok=True)
    # launchd doesn't read the shell profile: give it node's folder and the orca CLI folder explicitly.
    path = [os.path.dirname(node), str(Path.home() / '.local' / 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
    agent = {
        'Label': LABEL,
        'ProgramArguments': [node, str(root / 'server.js')],
        'WorkingDirectory': str(root),
        'RunAtLoad': True,
        'KeepAlive': True,
        'StandardOutPath': str(log),
        'StandardErrorPath': str(log),
        'EnvironmentVariables': {'PATH': ':'.join(path)},
    }
    args.agents_dir.mkdir(parents=True, exist_ok=True)
    launchctl('bootout', domain + '/' + LABEL)  # replace a copy that is already loaded
    plist.write_bytes(plistlib.dumps(agent))
    if launchctl('bootstrap', domain, str(plist)) != 0:
        raise SystemExit('launchctl không nạp được ' + str(plist))
    print('Orca Deck sẽ tự chạy khi đăng nhập. Nhật ký: ' + str(log))
    print('Ghép thiết bị: http://127.0.0.1:8766/pair')


if __name__ == '__main__':
    main()
