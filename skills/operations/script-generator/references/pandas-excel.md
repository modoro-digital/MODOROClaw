# Pandas Excel/CSV template patterns

Dùng pandas + openpyxl cho task Excel/CSV. Tránh nếu stdlib `csv` đủ.

## Read Excel → JSON

```python
"""Đọc Excel, output JSON ra stdout."""
import sys, json, argparse
import pandas as pd

def main():
    p = argparse.ArgumentParser()
    p.add_argument('filepath')
    p.add_argument('--sheet', default=0, help='Sheet name or index')
    args = p.parse_args()
    try:
        df = pd.read_excel(args.filepath, sheet_name=args.sheet)
        print(df.to_json(orient='records', force_ascii=False))
    except Exception as e:
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
```

## Merge multiple Excel files

```python
"""Merge N Excel files theo cùng schema, output 1 file mới."""
import sys, argparse
import pandas as pd

def main():
    p = argparse.ArgumentParser()
    p.add_argument('output')
    p.add_argument('inputs', nargs='+')
    args = p.parse_args()
    dfs = [pd.read_excel(f) for f in args.inputs]
    merged = pd.concat(dfs, ignore_index=True)
    merged.to_excel(args.output, index=False)
    print(f'OK merged {len(args.inputs)} files → {args.output} ({len(merged)} rows)')

if __name__ == '__main__':
    main()
```

## Filter rows by condition

```python
"""Filter rows match condition column=value, output filtered Excel."""
import sys, argparse
import pandas as pd

def main():
    p = argparse.ArgumentParser()
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--column', required=True)
    p.add_argument('--value', required=True)
    args = p.parse_args()
    df = pd.read_excel(args.input)
    if args.column not in df.columns:
        print(f'Column "{args.column}" not in: {list(df.columns)}', file=sys.stderr)
        sys.exit(1)
    filtered = df[df[args.column].astype(str).str.contains(args.value, case=False, na=False)]
    filtered.to_excel(args.output, index=False)
    print(f'Filtered {len(filtered)}/{len(df)} rows → {args.output}')

if __name__ == '__main__':
    main()
```

## Aggregate by group

```python
"""Group by column → aggregate (sum/mean/count)."""
import sys, argparse, json
import pandas as pd

def main():
    p = argparse.ArgumentParser()
    p.add_argument('filepath')
    p.add_argument('--group-by', required=True)
    p.add_argument('--agg-column', required=True)
    p.add_argument('--method', default='sum', choices=['sum','mean','count','min','max'])
    args = p.parse_args()
    df = pd.read_excel(args.filepath)
    result = df.groupby(args.group_by)[args.agg_column].agg(args.method).reset_index()
    print(result.to_json(orient='records', force_ascii=False))

if __name__ == '__main__':
    main()
```

## Notes

- Vietnamese column headers OK — pandas handles UTF-8
- Date columns: pass `parse_dates=['col_name']` to read_excel
- Large files (>100MB): use `chunksize` param
- Cần install: `pandas openpyxl` (pandas auto-detect openpyxl)
