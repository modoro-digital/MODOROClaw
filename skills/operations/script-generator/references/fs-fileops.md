# File operations template

Stdlib only — `pathlib`, `shutil`, `glob`, `os`. KHÔNG cần install.

## Find files matching pattern

```python
"""List files matching pattern, output JSON."""
import sys, json, argparse, os
from pathlib import Path

def main():
    p = argparse.ArgumentParser()
    p.add_argument('root')
    p.add_argument('--pattern', default='*.pdf', help='glob pattern')
    p.add_argument('--recursive', action='store_true')
    p.add_argument('--min-size-kb', type=int, default=0)
    args = p.parse_args()
    root = Path(args.root)
    if not root.exists(): print(f'Not found: {args.root}', file=sys.stderr); sys.exit(1)
    files = list(root.rglob(args.pattern) if args.recursive else root.glob(args.pattern))
    results = []
    for f in files:
        if not f.is_file(): continue
        size_kb = f.stat().st_size // 1024
        if size_kb < args.min_size_kb: continue
        results.append({
            'path': str(f),
            'name': f.name,
            'size_kb': size_kb,
            'mtime': int(f.stat().st_mtime),
        })
    print(json.dumps(results, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
```

## Backup folder → zip

```python
"""Zip a folder for backup."""
import sys, argparse, shutil, os, datetime as dt

def main():
    p = argparse.ArgumentParser()
    p.add_argument('source_dir')
    p.add_argument('--output-dir', default='.')
    p.add_argument('--name', default=None)
    args = p.parse_args()
    if not os.path.isdir(args.source_dir):
        print(f'Not a dir: {args.source_dir}', file=sys.stderr); sys.exit(1)
    name = args.name or f'backup-{dt.datetime.now().strftime("%Y-%m-%d-%H%M%S")}'
    out = os.path.join(args.output_dir, name)
    archive = shutil.make_archive(out, 'zip', args.source_dir)
    size_mb = os.path.getsize(archive) // (1024*1024)
    print(f'OK backup → {archive} ({size_mb}MB)')

if __name__ == '__main__':
    main()
```

## File watcher (one-shot snapshot)

```python
"""Snapshot folder state: hash all files, output JSON. Run again later to diff."""
import sys, json, argparse, hashlib
from pathlib import Path

def main():
    p = argparse.ArgumentParser()
    p.add_argument('root')
    p.add_argument('--prev-snapshot', help='Path to previous snapshot JSON for diff')
    args = p.parse_args()
    root = Path(args.root)
    snapshot = {}
    for f in root.rglob('*'):
        if not f.is_file(): continue
        rel = str(f.relative_to(root))
        h = hashlib.md5(f.read_bytes()).hexdigest()
        snapshot[rel] = {'hash': h, 'size': f.stat().st_size, 'mtime': int(f.stat().st_mtime)}
    if args.prev_snapshot:
        prev = json.load(open(args.prev_snapshot))
        added = [f for f in snapshot if f not in prev]
        removed = [f for f in prev if f not in snapshot]
        modified = [f for f in snapshot if f in prev and snapshot[f]['hash'] != prev[f]['hash']]
        print(json.dumps({'added': added, 'removed': removed, 'modified': modified}, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(snapshot, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    main()
```

## Rename batch by pattern

```python
"""Bulk rename files theo template."""
import sys, argparse, os, re
from pathlib import Path

def main():
    p = argparse.ArgumentParser()
    p.add_argument('input_dir')
    p.add_argument('--find', required=True)
    p.add_argument('--replace', required=True)
    p.add_argument('--regex', action='store_true')
    p.add_argument('--dry-run', action='store_true')
    args = p.parse_args()
    count = 0
    for f in Path(args.input_dir).iterdir():
        if not f.is_file(): continue
        if args.regex:
            new_name = re.sub(args.find, args.replace, f.name)
        else:
            new_name = f.name.replace(args.find, args.replace)
        if new_name != f.name:
            target = f.parent / new_name
            print(f'{f.name} → {new_name}')
            if not args.dry_run:
                f.rename(target)
            count += 1
    print(f'OK {count} files {"would be" if args.dry_run else ""} renamed')

if __name__ == '__main__':
    main()
```

## Notes

- `pathlib` modern API > old `os.path` — prefer
- `glob` cho simple patterns; `rglob` cho recursive
- Vietnamese filename + path: Python 3 handle Unicode tự nhiên
- Always check `if f.is_file()` trước khi xử lý — tránh follow symlinks
- Dry-run mode bắt buộc cho destructive ops (delete, rename, move)
