; 9BizClaw custom uninstaller cleanup
;
; DESIGN PRINCIPLE: Uninstaller NEVER touches user data. Windows convention —
; uninstall removes the app, keeps %APPDATA%. If user wants a full factory
; reset, use the separate "Factory Reset" button in Dashboard (which has
; 2-layer confirmation + explicit "XÓA" type-to-confirm).
;
; Silent mode (${Silent}) = triggered by new installer during upgrade. Skip
; ALL prompts so upgrade is seamless and data is preserved.
;
; Non-silent mode (user manually uninstalled from Windows Settings):
;   - Offer to free disk space by removing extracted vendor (~1.8 GB). Low risk:
;     if they reinstall, vendor auto-extracts from bundled tar on first launch.
;   - Do NOT offer to wipe data. Ever.

!macro customRemoveFiles
  ${IfNot} ${Silent}
    ; Offer to remove extracted vendor (~1.8 GB) — disk space only, no user data
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Xoa Node.js va plugin da giai nen? (~1.8 GB)$\n$\nGom: vendor/node, openclaw, 9router, openzca, openzalo$\nNeu cai lai, file nay se duoc giai nen tu dau.$\n$\nLUU Y: Du lieu bot (Zalo, Telegram, knowledge) KHONG bi xoa." \
      /SD IDNO \
      IDYES removeVendor IDNO skipVendor
    removeVendor:
      DetailPrint "Removing extracted vendor..."
      RMDir /r "$APPDATA\modoro-claw\vendor"
      Delete "$APPDATA\modoro-claw\vendor-version.txt"
      DetailPrint "Vendor removed."
    skipVendor:
  ${EndIf}
!macroend
