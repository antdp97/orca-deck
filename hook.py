#!/usr/bin/python3
"""Bridge one Claude permission request to the local deck; errors keep native approval."""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--runtime', type=Path, default=Path(__file__).parent / '.local' / 'runtime.json')
    args = parser.parse_args()
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return
        runtime = json.loads(args.runtime.read_text())
        payload['orca_tab_id'] = os.environ.get('ORCA_TAB_ID', '')
        payload['orca_worktree_id'] = os.environ.get('ORCA_WORKTREE_ID', '')
        request = urllib.request.Request(
            'http://127.0.0.1:%d/api/hook' % int(runtime['port']),
            data=json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + runtime['hookToken'], 'Content-Type': 'application/json'},
            method='POST',
        )
        # Local requests must never be sent through system HTTP proxies.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=185) as response:
            data = json.load(response)
        behavior = data.get('hookSpecificOutput', {}).get('decision', {}).get('behavior')
        if behavior in ('allow', 'deny'):
            print(json.dumps({'hookSpecificOutput': {'hookEventName': 'PermissionRequest', 'decision': {'behavior': behavior}}}))
    except Exception:
        # Empty output does not grant permission; Claude falls back to its normal prompt.
        return


if __name__ == '__main__':
    main()
