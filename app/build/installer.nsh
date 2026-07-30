!macro customInit
  ; Offer to wipe a previous install's data (logs/prefs/ssh setup state under
  ; %APPDATA%\CTTC) before laying down fresh files -- a plain reinstall
  ; otherwise silently keeps stale prefs/session state from an older version.
  ${IfNot} ${Silent}
    ${If} ${FileExists} "$APPDATA\${PRODUCT_NAME}\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "A previous CTTC install's data was found.$\r$\n$\r$\nErase it and start fresh?" \
        IDNO +2
      RMDir /r "$APPDATA\${PRODUCT_NAME}"
    ${EndIf}
  ${EndIf}
!macroend
