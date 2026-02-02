; ============================================================================
; Android Remote Agent — NSIS Installer
; ============================================================================
; Build:  makensis installer.nsi
; Output: Setup-AndroidRemote.exe
;
; Supports three install modes:
;   1. Pre-configured: server URL + token baked into exe via JSON trailer
;   2. Command-line:   Setup.exe /S /SERVER_URL=https://... /TOKEN=ABC123
;   3. If neither, shows error asking for parameters
; ============================================================================

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"

; ── Product info ────────────────────────────────────────────────────────────

!define PRODUCT_NAME    "Android Remote Agent"
!define PRODUCT_PUBLISHER "Android Remote"
!define PRODUCT_EXE     "android-remote-agent.exe"
!define UNINSTALL_KEY   "Software\Microsoft\Windows\CurrentVersion\Uninstall\AndroidRemoteAgent"
!define INSTALL_DIR     "$PROGRAMFILES\AndroidRemoteAgent"

; Magic marker for trailer detection (8 bytes)
!define TRAILER_MAGIC   "ARCFG"

Name "${PRODUCT_NAME}"
OutFile "..\..\dist\Setup-AndroidRemote.exe"
InstallDir "${INSTALL_DIR}"
RequestExecutionLevel admin
ShowInstDetails show
ShowUnInstDetails show

; ── Variables ───────────────────────────────────────────────────────────────

Var SERVER_URL
Var TOKEN
Var INSTALL_RESULT

; ── MUI Settings ────────────────────────────────────────────────────────────

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!define MUI_WELCOMEPAGE_TITLE "Welcome to ${PRODUCT_NAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "This will install the ${PRODUCT_NAME} on your computer.$\r$\n$\r$\nThe agent connects your device to the management server for remote monitoring and control.$\r$\n$\r$\nClick Install to continue."

!define MUI_FINISHPAGE_TITLE "Installation Complete"
!define MUI_FINISHPAGE_TEXT "The ${PRODUCT_NAME} has been installed and the service is now running.$\r$\n$\r$\nYour device will appear in the management dashboard shortly."

; ── Pages ───────────────────────────────────────────────────────────────────

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; ── Functions ───────────────────────────────────────────────────────────────

Function .onInit
  ; First, try to read config from appended trailer
  Call ReadTrailerConfig

  ; If trailer didn't provide values, check command-line parameters
  ${If} $SERVER_URL == ""
    ; Parse /SERVER_URL=value from command line
    ${GetParameters} $0
    ${GetOptions} $0 "/SERVER_URL=" $SERVER_URL
  ${EndIf}

  ${If} $TOKEN == ""
    ${GetParameters} $0
    ${GetOptions} $0 "/TOKEN=" $TOKEN
  ${EndIf}

  ; Validate we have both required values
  ${If} $SERVER_URL == ""
  ${OrIf} $TOKEN == ""
    ; In silent mode, abort with error
    IfSilent 0 +3
      SetErrorLevel 1
      Abort
    ; In GUI mode, show error
    MessageBox MB_OK|MB_ICONSTOP "This installer requires a server URL and enrollment token.$\r$\n$\r$\nEither:$\r$\n  - Download a pre-configured installer from the admin dashboard$\r$\n  - Run: Setup.exe /S /SERVER_URL=https://... /TOKEN=ABC123"
    Abort
  ${EndIf}
FunctionEnd

; Read JSON trailer appended after the NSIS exe
; Format: [exe bytes][JSON][4-byte JSON length LE][8-byte magic "ARCFG\x00\x00\x00"]
Function ReadTrailerConfig
  ; Open our own exe
  FileOpen $0 "$EXEPATH" r

  ${If} $0 == ""
    Return
  ${EndIf}

  ; Seek to end - 8 bytes to read magic marker
  FileSeek $0 0 END $1  ; $1 = file size
  IntOp $2 $1 - 8
  FileSeek $0 $2 SET
  FileRead $0 $3 5  ; Read first 5 bytes of magic

  ${If} $3 != "${TRAILER_MAGIC}"
    FileClose $0
    Return
  ${EndIf}

  ; Read the 4-byte JSON length (just before the magic)
  IntOp $2 $1 - 12  ; 8 (magic) + 4 (length) = 12 bytes from end
  FileSeek $0 $2 SET
  FileReadByte $0 $4  ; byte 0 (LSB)
  FileReadByte $0 $5  ; byte 1
  FileReadByte $0 $6  ; byte 2
  FileReadByte $0 $7  ; byte 3

  ; Reconstruct uint32 LE: $4 + ($5 << 8) + ($6 << 16) + ($7 << 24)
  IntOp $5 $5 << 8
  IntOp $6 $6 << 16
  IntOp $7 $7 << 24
  IntOp $4 $4 + $5
  IntOp $4 $4 + $6
  IntOp $4 $4 + $7  ; $4 = JSON length

  ; Sanity check: JSON length should be reasonable (< 10KB)
  ${If} $4 > 10240
  ${OrIf} $4 < 2
    FileClose $0
    Return
  ${EndIf}

  ; Seek to start of JSON: file_size - 12 - json_length
  IntOp $2 $1 - 12
  IntOp $2 $2 - $4
  FileSeek $0 $2 SET
  FileRead $0 $3 $4  ; $3 = JSON string

  FileClose $0

  ; Write JSON to a temp file so we can parse it with nsJSON or simple string ops
  ; Simple approach: extract serverUrl and enrollToken with string search
  ; Look for "serverUrl":"VALUE"
  Call ParseJsonServerUrl
  Call ParseJsonToken
FunctionEnd

; Extract serverUrl from JSON in $3
Function ParseJsonServerUrl
  Push $3
  Push '"serverUrl":"'
  Call StrStr
  Pop $0
  ${If} $0 == ""
    Return
  ${EndIf}
  ; $0 starts at the value after "serverUrl":"
  StrLen $1 '"serverUrl":"'
  StrCpy $0 $0 "" $1
  ; Find closing quote
  Push $0
  Push '"'
  Call StrStr
  Pop $1
  ${If} $1 == ""
    Return
  ${EndIf}
  ; Calculate length = total - remainder
  StrLen $2 $0
  StrLen $4 $1
  IntOp $2 $2 - $4
  StrCpy $SERVER_URL $0 $2
FunctionEnd

; Extract enrollToken from JSON in $3
Function ParseJsonToken
  Push $3
  Push '"enrollToken":"'
  Call StrStr
  Pop $0
  ${If} $0 == ""
    Return
  ${EndIf}
  StrLen $1 '"enrollToken":"'
  StrCpy $0 $0 "" $1
  Push $0
  Push '"'
  Call StrStr
  Pop $1
  ${If} $1 == ""
    Return
  ${EndIf}
  StrLen $2 $0
  StrLen $4 $1
  IntOp $2 $2 - $4
  StrCpy $TOKEN $0 $2
FunctionEnd

; StrStr - find substring in string
; Usage: Push "haystack" / Push "needle" / Call StrStr / Pop $0
; Returns: substring starting at needle, or "" if not found
Function StrStr
  Exch $R1 ; needle
  Exch
  Exch $R2 ; haystack
  Push $R3
  Push $R4
  Push $R5
  StrLen $R3 $R1
  StrCpy $R5 0
  loop:
    StrCpy $R4 $R2 $R3 $R5
    StrCmp $R4 "" done
    StrCmp $R4 $R1 found
    IntOp $R5 $R5 + 1
    Goto loop
  found:
    StrCpy $R2 $R2 "" $R5
    Goto done
  done:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R1
    Exch $R2  ; result on stack
FunctionEnd

; ── Install Section ─────────────────────────────────────────────────────────

Section "Install"
  SetOutPath $INSTDIR

  ; Extract the agent binary
  File "..\..\dist\android-remote-agent-windows-x64.exe"
  Rename "$INSTDIR\android-remote-agent-windows-x64.exe" "$INSTDIR\${PRODUCT_EXE}"

  DetailPrint "Installing agent service..."
  DetailPrint "Server: $SERVER_URL"

  ; Run the agent's install subcommand (silent, with --install-dir pointing here)
  nsExec::ExecToLog '"$INSTDIR\${PRODUCT_EXE}" install --server-url "$SERVER_URL" --enroll-token "$TOKEN" --install-dir "$INSTDIR"'
  Pop $INSTALL_RESULT

  ${If} $INSTALL_RESULT != "0"
    DetailPrint "Agent install returned: $INSTALL_RESULT"
    ; Don't abort — the service might still have been created
  ${Else}
    DetailPrint "Agent service installed and started successfully."
  ${EndIf}

  ; Create uninstaller
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Start Menu shortcut
  CreateDirectory "$SMPROGRAMS\${PRODUCT_NAME}"
  CreateShortCut "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"

  ; Add/Remove Programs registry entries
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegStr HKLM "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\${PRODUCT_EXE}"
  WriteRegStr HKLM "${UNINSTALL_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "NoRepair" 1

  ; Calculate installed size for Add/Remove Programs
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINSTALL_KEY}" "EstimatedSize" $0
SectionEnd

; ── Uninstall Section ───────────────────────────────────────────────────────

Section "Uninstall"
  DetailPrint "Stopping and removing agent service..."

  ; Run the agent's uninstall subcommand with --purge
  nsExec::ExecToLog '"$INSTDIR\${PRODUCT_EXE}" uninstall --purge'
  Pop $0

  ; Remove files
  Delete "$INSTDIR\${PRODUCT_EXE}"
  Delete "$INSTDIR\config.json"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"

  ; Remove Start Menu shortcuts
  Delete "$SMPROGRAMS\${PRODUCT_NAME}\Uninstall.lnk"
  RMDir "$SMPROGRAMS\${PRODUCT_NAME}"

  ; Remove registry entries
  DeleteRegKey HKLM "${UNINSTALL_KEY}"
SectionEnd
