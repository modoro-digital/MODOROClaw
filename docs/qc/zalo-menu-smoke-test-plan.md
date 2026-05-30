# Zalo Menu Smoke Test Plan

Scope: Zalo Dashboard subtabs, Menu catalog, XLSX import, and dry-run preview. Payment and SePay are out of scope for v1.

## Automated Gates

Run before manual smoke:

```bash
cd electron
npm run guard:zalo-menu-dry-run
npm run guard:qc-release
npm run guard:dashboard-ux
```

Expected:

- `guard:zalo-menu-dry-run` passes catalog, command, import, size-limit, row-limit, opaque-token, payment-exclusion, and laptop-collapse assertions.
- `guard:qc-release` passes checklist, smoke plan, and package guard wiring assertions.
- `guard:dashboard-ux` passes existing Dashboard loading, error, confirm, and media state checks.

## Manual Packaged-App Smoke

Run against the packaged app, not only development Electron.

1. Open Zalo tab.
2. Confirm large subtabs show `Tổng quan` and `Menu`.
3. At 1366x768 and 1280px width, confirm group/friend rows are readable and actions do not overlap.
4. Switch to `Menu`.
5. Confirm top actions show `Tải mẫu XLSX`, `Import XLSX`, and `Dry-run`.
6. Type `/menu`, press Enter, confirm preview renders a list.
7. Type `/menu premium`, press Enter, confirm preview includes bold `9BizClaw Premium`.
8. Type `/baogia premium`, press Enter, confirm preview has No SePay, no QR, no bank transfer, no account number, and no payment instructions.
9. Confirm Dry-run never sends anything to Zalo.

## XLSX Import

1. Download template with `Tải mẫu XLSX`.
2. Fill one new row with a unique slug and Vietnamese text.
3. Import XLSX.
4. Confirm preview count before applying.
5. Apply import.
6. Save catalog.
7. Restart persistence: quit app, reopen, confirm imported catalog is still present.

Negative import cases:

- Duplicate slug is rejected.
- Missing title is rejected.
- Oversized file is rejected before parsing.
- More than 500 menu rows is rejected.
- Formula cells are rejected as formula risk.
- Hyperlink cells are rejected as hyperlink risk.
- Replacing the selected file between preview and apply is rejected as file replacement.
- Canceling the picker leaves the existing catalog untouched.

## Safety Checks

- Dry-run never sends.
- Customer Zalo sees only final formatted menu messages after command dispatch exists.
- Dashboard does not expose local import paths to renderer code.
- Imported HTML-like text renders inert in the preview.
- Payment remains future work; no SePay webhook, QR, bank transfer, or payment instruction appears in v1.

## Exit Criteria

- Automated gates pass.
- Manual packaged-app smoke has no P0 findings.
- Any P1 finding has an owner and explicit release decision.
