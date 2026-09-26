; FluxDown GPUI Windows installer
#define MyAppName "FluxDown"
#define MyAppPublisher "FluxDown"
#define MyAppURL "https://github.com/990121-1/FluxDown111"
#define MyAppExeName "fluxdown-desktop.exe"
#ifndef MyAppVersion
  #define MyAppVersion "0.1.0"
#endif
[Setup]
AppId={{B7E3F2A1-5C4D-4E8F-9A6B-1D2E3F4A5B6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
DefaultDirName={localappdata}\Programs\FluxDown
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\build\installer
OutputBaseFilename=FluxDown-{#MyAppVersion}-windows-x64-setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
CloseApplications=force
RestartApplications=no
SetupIconFile=..\..\assets\logo\app_icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
LicenseFile=..\..\LICENSE
[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "launchonstartup"; Description: "Start FluxDown with Windows"; GroupDescription: "Startup:"; Flags: unchecked
Name: "torrentassoc"; Description: "Associate .torrent files with FluxDown"; GroupDescription: "File associations:"; Flags: unchecked
[Files]
Source: "..\..\target\release\fluxdown-desktop.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\target\release\fluxdown-agent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\target\release\fluxdownd.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\..\target\release\fluxdown_nmh.exe"; DestDir: "{app}"; Flags: ignoreversion
[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon
[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "FluxDown"; ValueData: """{app}\{#MyAppExeName}"" --minimized"; Flags: uninsdeletevalue; Tasks: launchonstartup
Root: HKCU; Subkey: "Software\Classes\.torrent"; ValueType: string; ValueData: "FluxDown.TorrentFile"; Flags: uninsdeletekey; Tasks: torrentassoc
Root: HKCU; Subkey: "Software\Classes\FluxDown.TorrentFile\shell\open\command"; ValueType: string; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey; Tasks: torrentassoc
[Code]
procedure KillFluxDown;
var ResultCode: Integer;
begin
  Exec('taskkill.exe', '/F /T /IM fluxdown-desktop.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM fluxdown-agent.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM fluxdownd.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec('taskkill.exe', '/F /T /IM fluxdown_nmh.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  KillFluxDown;
  Result := '';
end;
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    KillFluxDown;
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Google\Chrome\NativeMessagingHosts\com.fluxdown.nmh');
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Microsoft\Edge\NativeMessagingHosts\com.fluxdown.nmh');
    RegDeleteKeyIncludingSubkeys(HKCU, 'Software\Mozilla\NativeMessagingHosts\com.fluxdown.nmh');
  end;
end;
