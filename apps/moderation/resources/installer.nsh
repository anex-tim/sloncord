; После тихого обновления Windows иногда «теряет» иконку ярлыка (белый лист).
; Явно пересоздаём ярлыки с app-icon.ico из resources (см. build.extraResources).

!macro customInstall
  StrCpy $0 "$INSTDIR\resources\app-icon.ico"
  ${if} ${FileExists} "$0"
    ${if} ${FileExists} "$newDesktopLink"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    ${endIf}

    ${if} ${FileExists} "$newStartMenuLink"
      CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ${endIf}
  ${endIf}
!macroend
