; 9BizClaw custom installer/uninstaller hooks
;
; DESIGN PRINCIPLE: Uninstaller NEVER touches user data. Windows convention —
; uninstall removes the app, keeps %APPDATA%. If user wants a full factory
; reset, use the separate "Factory Reset" button in Dashboard.
;
; Silent mode (${Silent}) = triggered by new installer during upgrade.

!macro customInstall
  ; Add vendor/node_modules/.bin to user PATH so openclaw/9router/openzca
  ; work in any terminal, just like a normal global npm install.
  ; Uses User-scope (not Machine-scope) so no admin required.
  ; Uses %APPDATA% so it resolves to the actual user's folder dynamically.
  DetailPrint "Adding vendor CLI to user PATH..."
  nsExec::ExecToLog 'powershell -NoProfile -Command "$$p = [Environment]::GetEnvironmentVariable(''PATH'',''User''); $$bin = Join-Path $$env:APPDATA ''9bizclaw\vendor\node_modules\.bin''; if ($$p -notlike ''*'' + $$bin + ''*'') { $$newPath = $$p + '';'' + $$bin; [Environment]::SetEnvironmentVariable(''PATH'', $$newPath, ''User'') }"'
!macroend

!macro customRemoveFiles
  ; Clean up user PATH: remove 9bizclaw entries (CLI shims + vendor bin)
  DetailPrint "Cleaning user PATH..."
  nsExec::ExecToLog 'powershell -NoProfile -Command "$$p = [Environment]::GetEnvironmentVariable(''PATH'',''User''); if ($$p) { $$parts = $$p -split '';'' | Where-Object { $$_ -notlike ''*9bizclaw*'' }; [Environment]::SetEnvironmentVariable(''PATH'', ($$parts -join '';''), ''User'') }"'

  ; Remove CLI shim dir + generated PATH helpers (the *9bizclaw* PATH filter
  ; above already strips the bin dir from user PATH).
  DetailPrint "Removing CLI shims..."
  RMDir /r "$APPDATA\9bizclaw\cli"
  RMDir /r "$APPDATA\9bizclaw\bin"
  Delete "$APPDATA\9bizclaw\.add-to-path.ps1"
  Delete "$APPDATA\9bizclaw\.cli-path-added"

  ; Ask user about runtime vendor dir (~200 MB)
  ${IfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Remove runtime files (~200 MB)? Data is preserved." \
      /SD IDNO \
      IDYES removeVendor IDNO skipVendor
    removeVendor:
      DetailPrint "Removing runtime vendor..."
      RMDir /r "$APPDATA\9bizclaw\vendor"
      Delete "$APPDATA\9bizclaw\runtime-version.txt"
      Delete "$APPDATA\9bizclaw\vendor-version.txt"
      DetailPrint "Runtime removed."
    skipVendor:
  ${EndIf}
!macroend
