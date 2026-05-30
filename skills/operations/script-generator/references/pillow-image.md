# Pillow image batch template

Image batch ops: resize, watermark, crop, convert. Pillow stdlib (cần `pip install Pillow`).

## Batch resize

```python
"""Resize tất cả ảnh trong folder về kích thước cố định."""
import sys, os, glob, argparse
from PIL import Image

def main():
    p = argparse.ArgumentParser()
    p.add_argument('input_dir')
    p.add_argument('--output-dir', default=None, help='Default: input_dir/resized/')
    p.add_argument('--width', type=int, default=800)
    p.add_argument('--height', type=int, default=800)
    p.add_argument('--mode', default='contain', choices=['contain','cover','stretch'])
    p.add_argument('--quality', type=int, default=85)
    args = p.parse_args()
    out_dir = args.output_dir or os.path.join(args.input_dir, 'resized')
    os.makedirs(out_dir, exist_ok=True)
    exts = ('*.jpg', '*.jpeg', '*.png', '*.webp')
    files = []
    for e in exts: files.extend(glob.glob(os.path.join(args.input_dir, e)))
    count = 0
    for f in files:
        try:
            img = Image.open(f)
            if args.mode == 'contain':
                img.thumbnail((args.width, args.height), Image.Resampling.LANCZOS)
            elif args.mode == 'stretch':
                img = img.resize((args.width, args.height), Image.Resampling.LANCZOS)
            elif args.mode == 'cover':
                from PIL import ImageOps
                img = ImageOps.fit(img, (args.width, args.height), Image.Resampling.LANCZOS)
            out = os.path.join(out_dir, os.path.basename(f))
            img.save(out, quality=args.quality)
            count += 1
        except Exception as e:
            print(f'Skip {f}: {e}', file=sys.stderr)
    print(f'OK resized {count}/{len(files)} → {out_dir}')

if __name__ == '__main__':
    main()
```

## Add watermark

```python
"""Add watermark text/logo lên ảnh."""
import sys, os, glob, argparse
from PIL import Image, ImageDraw, ImageFont

def main():
    p = argparse.ArgumentParser()
    p.add_argument('input_dir')
    p.add_argument('--output-dir', default=None)
    p.add_argument('--text', default='© 9bizclaw')
    p.add_argument('--position', default='bottom-right', choices=['top-left','top-right','bottom-left','bottom-right','center'])
    p.add_argument('--opacity', type=int, default=128)
    args = p.parse_args()
    out_dir = args.output_dir or os.path.join(args.input_dir, 'watermarked')
    os.makedirs(out_dir, exist_ok=True)
    files = [f for ext in ('*.jpg','*.png','*.webp') for f in glob.glob(os.path.join(args.input_dir, ext))]
    for f in files:
        img = Image.open(f).convert('RGBA')
        w, h = img.size
        overlay = Image.new('RGBA', img.size, (255,255,255,0))
        draw = ImageDraw.Draw(overlay)
        try: font = ImageFont.truetype('arial.ttf', max(20, w//30))
        except: font = ImageFont.load_default()
        bbox = draw.textbbox((0,0), args.text, font=font)
        tw, th = bbox[2]-bbox[0], bbox[3]-bbox[1]
        positions = {
            'top-left': (10, 10), 'top-right': (w-tw-10, 10),
            'bottom-left': (10, h-th-20), 'bottom-right': (w-tw-10, h-th-20),
            'center': ((w-tw)//2, (h-th)//2),
        }
        x, y = positions[args.position]
        draw.text((x, y), args.text, font=font, fill=(255,255,255,args.opacity))
        combined = Image.alpha_composite(img, overlay)
        combined.convert('RGB').save(os.path.join(out_dir, os.path.basename(f)), quality=90)
    print(f'OK watermarked {len(files)} → {out_dir}')

if __name__ == '__main__':
    main()
```

## Convert PNG → WebP

```python
"""Convert images sang WebP để giảm kích thước."""
import sys, os, glob, argparse
from PIL import Image

def main():
    p = argparse.ArgumentParser()
    p.add_argument('input_dir')
    p.add_argument('--quality', type=int, default=80)
    args = p.parse_args()
    files = glob.glob(os.path.join(args.input_dir, '*.png')) + glob.glob(os.path.join(args.input_dir, '*.jpg'))
    saved = 0; orig_total = 0; webp_total = 0
    for f in files:
        try:
            img = Image.open(f)
            out = os.path.splitext(f)[0] + '.webp'
            img.save(out, 'webp', quality=args.quality)
            orig_total += os.path.getsize(f); webp_total += os.path.getsize(out)
            saved += 1
        except Exception as e:
            print(f'Skip {f}: {e}', file=sys.stderr)
    print(f'OK converted {saved} files. Original {orig_total//1024}KB → WebP {webp_total//1024}KB ({100*webp_total//orig_total}% size)')

if __name__ == '__main__':
    main()
```

## Notes

- Pillow stdlib KHÔNG có sẵn — cần `pip install Pillow`
- Format support: JPG, PNG, WebP, GIF, BMP, TIFF
- Big images (>50MB) → load slow + RAM hog. Default OK cho ảnh sản phẩm thông thường
- Font Vietnamese: dùng `arial.ttf` (Windows) hoặc `DejaVuSans.ttf` (Linux/Mac)
