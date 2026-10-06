; Custom NSIS hook for electron-builder.
; Fix: after silent update Windows иногда «теряет» иконку у ярлыка (показывает белый лист).
; Переписываем ярлыки (desktop + start menu) на явный .ico из ресурсов, не полагаясь на icon в .exe.

!macro customInstall
  ; Путь к ico, который кладём как extraResources (см. build.extraResources).
  StrCpy $0 "$INSTDIR\resources\app-icon.ico"
  ${if} ${FileExists} "$0"
    ; Desktop shortcut (если он включён и существует).
    ${if} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}

    ; Start menu shortcut (если он включён и существует).
    ${if} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  ${endIf}
!macroend

