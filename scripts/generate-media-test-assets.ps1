$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$root = Join-Path $repoRoot "docs\generated\media-test-assets"
New-Item -ItemType Directory -Force -Path $root | Out-Null

Add-Type -AssemblyName System.Drawing

function New-Brush([int]$r, [int]$g, [int]$b) {
  return New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($r, $g, $b))
}

function New-Pen([int]$r, [int]$g, [int]$b, [float]$width = 1.0) {
  return New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($r, $g, $b), $width)
}

function Save-Jpeg([string]$path, [scriptblock]$drawBlock, [int]$width = 1600, [int]$height = 1000) {
  $bmp = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  & $drawBlock $g $width $height

  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
  $encoder = [System.Drawing.Imaging.Encoder]::Quality
  $encoderParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
  $encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter($encoder, 92L)
  $bmp.Save($path, $codec, $encoderParams)

  $g.Dispose()
  $bmp.Dispose()
}

function Save-Png([string]$path, [scriptblock]$drawBlock, [int]$width = 1200, [int]$height = 1200) {
  $bmp = New-Object System.Drawing.Bitmap $width, $height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  & $drawBlock $g $width $height
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}

function New-RoundedRectPath([float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc($x + $width - $diameter, $y + $height - $diameter, $diameter, $diameter, 0, 90)
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-RoundedRect($graphics, $brush, [float]$x, [float]$y, [float]$width, [float]$height, [float]$radius) {
  $path = New-RoundedRectPath $x $y $width $height $radius
  $graphics.FillPath($brush, $path)
  $path.Dispose()
}

function Escape-PdfText([string]$text) {
  return $text.Replace('\', '\\').Replace('(', '\(').Replace(')', '\)')
}

function Build-Pdf([string]$outPath, [byte[]]$jpegBytes, [string[]]$lines, [string]$title) {
  $objects = New-Object System.Collections.Generic.List[string]
  $imgLength = $jpegBytes.Length
  $imgData = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($jpegBytes)

  $safeTitle = Escape-PdfText $title
  $escapedLines = $lines | ForEach-Object { Escape-PdfText $_ }
  $textOps = @(
    "BT",
    "/F1 24 Tf",
    "50 770 Td",
    "($safeTitle) Tj",
    "ET",
    "q",
    "380 0 0 240 50 470 cm",
    "/Im1 Do",
    "Q",
    "BT",
    "/F1 13 Tf",
    "50 430 Td"
  )
  foreach ($line in $escapedLines) {
    $textOps += "($line) Tj"
    $textOps += "0 -20 Td"
  }
  $textOps += "ET"
  $content = ($textOps -join "`n")

  $objects.Add("1 0 obj`n<< /Type /Catalog /Pages 2 0 R >>`nendobj")
  $objects.Add("2 0 obj`n<< /Type /Pages /Kids [3 0 R] /Count 1 >>`nendobj")
  $objects.Add("3 0 obj`n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 5 0 R >> >> /Contents 6 0 R >>`nendobj")
  $objects.Add("4 0 obj`n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`nendobj")
  $objects.Add("5 0 obj`n<< /Type /XObject /Subtype /Image /Width 1600 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length $imgLength >>`nstream`n$imgData`nendstream`nendobj")
  $objects.Add("6 0 obj`n<< /Length $($content.Length) >>`nstream`n$content`nendstream`nendobj")

  $header = "%PDF-1.4`n"
  $builder = New-Object System.Text.StringBuilder
  [void]$builder.Append($header)
  $offsets = New-Object System.Collections.Generic.List[int]
  $offsets.Add(0)

  foreach ($obj in $objects) {
    $offsets.Add($builder.Length)
    [void]$builder.Append($obj)
    [void]$builder.Append("`n")
  }

  $xrefOffset = $builder.Length
  [void]$builder.Append("xref`n0 ")
  [void]$builder.Append($offsets.Count)
  [void]$builder.Append("`n")
  [void]$builder.Append("0000000000 65535 f `n")
  for ($i = 1; $i -lt $offsets.Count; $i++) {
    [void]$builder.Append(($offsets[$i].ToString("0000000000")))
    [void]$builder.Append(" 00000 n `n")
  }
  [void]$builder.Append("trailer`n<< /Size ")
  [void]$builder.Append($offsets.Count)
  [void]$builder.Append(" /Root 1 0 R >>`nstartxref`n")
  [void]$builder.Append($xrefOffset)
  [void]$builder.Append("`n%%EOF")

  [System.IO.File]::WriteAllBytes($outPath, [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetBytes($builder.ToString()))
}

$logoPath = Join-Path $root "logo-9bizclaw-test.png"
Save-Png $logoPath {
  param($g, $w, $h)
  $g.Clear([System.Drawing.Color]::FromArgb(249, 246, 238))
  $gold = [System.Drawing.Color]::FromArgb(209, 168, 83)
  $dark = [System.Drawing.Color]::FromArgb(24, 24, 24)
  $accent = [System.Drawing.Color]::FromArgb(221, 61, 61)
  $goldBrush = New-Object System.Drawing.SolidBrush $gold
  $darkBrush = New-Object System.Drawing.SolidBrush $dark
  $accentBrush = New-Object System.Drawing.SolidBrush $accent
  $whiteBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillEllipse($darkBrush, 270, 190, 660, 660)
  $g.FillEllipse($goldBrush, 315, 235, 570, 570)
  $g.FillEllipse($accentBrush, 385, 305, 430, 430)
  $font1 = New-Object System.Drawing.Font("Arial", 70, [System.Drawing.FontStyle]::Bold)
  $font2 = New-Object System.Drawing.Font("Arial", 34, [System.Drawing.FontStyle]::Regular)
  $g.DrawString("9B", $font1, $whiteBrush, 475, 465)
  $g.DrawString("9BizClaw Test Brand", $font2, $darkBrush, 290, 920)
}

$blackPath = Join-Path $root "product-black.jpg"
Save-Jpeg $blackPath {
  param($g, $w, $h)
  $bg = [System.Drawing.Color]::FromArgb(244, 244, 246)
  $g.Clear($bg)
  $soft = New-Brush 230 231 235
  $shadow = New-Brush 205 207 214
  $dark = New-Brush 25 27 32
  $mid = New-Brush 56 60 68
  $gold = New-Brush 209 168 83
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillEllipse($shadow, 520, 700, 580, 120)
  Fill-RoundedRect $g $soft 220 120 1160 680 36
  Fill-RoundedRect $g $dark 420 250 760 350 48
  $g.FillEllipse($mid, 460, 300, 120, 120)
  $g.FillEllipse($gold, 1010, 300, 120, 120)
  $font1 = New-Object System.Drawing.Font("Arial", 54, [System.Drawing.FontStyle]::Bold)
  $font2 = New-Object System.Drawing.Font("Arial", 28, [System.Drawing.FontStyle]::Regular)
  $g.DrawString("Máy pha cà phê mẫu đen", $font1, $white, 505, 430)
  $g.DrawString("Bản demo để test vision và product image search", $font2, $white, 445, 525)
}

$redPath = Join-Path $root "product-red.jpg"
Save-Jpeg $redPath {
  param($g, $w, $h)
  $g.Clear([System.Drawing.Color]::FromArgb(250, 245, 245))
  $rose = New-Brush 209 47 47
  $dark = New-Brush 39 22 22
  $light = New-Brush 248 226 226
  $shadow = New-Brush 222 210 210
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $g.FillEllipse($shadow, 520, 700, 580, 120)
  Fill-RoundedRect $g $light 220 120 1160 680 36
  Fill-RoundedRect $g $dark 470 220 660 420 60
  $g.FillRectangle($rose, 560, 320, 480, 170)
  $font1 = New-Object System.Drawing.Font("Arial", 54, [System.Drawing.FontStyle]::Bold)
  $font2 = New-Object System.Drawing.Font("Arial", 30, [System.Drawing.FontStyle]::Regular)
  $g.DrawString("Loa thông minh mẫu đỏ", $font1, $dark, 430, 765)
  $g.DrawString("Ảnh test gửi Zalo và tìm theo màu sắc", $font2, $dark, 460, 835)
  $g.DrawString("RED", $font1, $white, 675, 360)
}

$posterPath = Join-Path $root "poster-text.jpg"
Save-Jpeg $posterPath {
  param($g, $w, $h)
  $g.Clear([System.Drawing.Color]::FromArgb(247, 243, 232))
  $black = New-Brush 22 22 22
  $gold = New-Brush 208 165 72
  $red = New-Brush 195 53 53
  $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $fontTitle = New-Object System.Drawing.Font("Arial", 70, [System.Drawing.FontStyle]::Bold)
  $fontBody = New-Object System.Drawing.Font("Arial", 30, [System.Drawing.FontStyle]::Regular)
  $g.FillRectangle($black, 90, 90, 1420, 820)
  $g.FillRectangle($gold, 90, 90, 20, 820)
  $g.FillEllipse($red, 980, 220, 350, 350)
  $g.DrawString("9BizClaw Demo Poster", $fontTitle, $white, 150, 180)
  $g.DrawString("Tài liệu test vision đọc ảnh có chữ", $fontBody, $white, 155, 310)
  $g.DrawString("Mục tiêu: kiểm tra OCR, mô tả hình, và search theo nội dung.", $fontBody, $white, 155, 390)
  $g.DrawString("Từ khóa nên tìm ra: demo poster, OCR, search nội dung, 9BizClaw.", $fontBody, $white, 155, 450)
}

$jpegForPdf = [System.IO.File]::ReadAllBytes($blackPath)

$textPdfPath = Join-Path $root "catalog-text.pdf"
Build-Pdf $textPdfPath $jpegForPdf @(
  "Catalog test co text that.",
  "San pham: May pha ca phe mau den.",
  "Bao hanh 12 thang.",
  "Thong so ky thuat: cong suat 1450W, ap suat 15 bar.",
  "Tu khoa de test search: bao hanh 12 thang, thong so ky thuat, mau den."
) "Catalog Text PDF"

$scanPdfPath = Join-Path $root "catalog-scan.pdf"
Build-Pdf $scanPdfPath $jpegForPdf @(
  "Day la ban scan mo phong.",
  "Noi dung chinh duoc render trong hinh anh de test vision.",
  "Tu khoa nhin thay tren trang: bao hanh 12 thang, mau den, may pha ca phe."
) "Catalog Scan PDF"

$readmePath = Join-Path $root "README.txt"
@"
Bo file test da tao:
- logo-9bizclaw-test.png
- product-black.jpg
- product-red.jpg
- poster-text.jpg
- catalog-text.pdf
- catalog-scan.pdf

Goi y test:
- Upload logo vao nhom brand
- Upload product-black.jpg va product-red.jpg vao nhom product
- Upload poster-text.jpg de test vision doc chu trong anh
- Upload catalog-text.pdf de test PDF co text that
- Upload catalog-scan.pdf de test PDF scan / vision pipeline
"@ | Set-Content -Path $readmePath -Encoding UTF8

Get-ChildItem $root | Select-Object Name, Length, LastWriteTime
