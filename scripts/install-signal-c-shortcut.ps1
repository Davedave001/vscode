# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for license information.

# A per-user development shortcut; it reuses the launcher rather than duplicating its profile and environment logic.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $PSScriptRoot 'code-agent-workspace.ts'
$icon = Join-Path $repoRoot 'resources/win32/code.ico'
$helper = Join-Path $repoRoot '.build/signal-c-shortcut.vbs'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$scriptHost = Join-Path ([Environment]::GetFolderPath('System')) 'wscript.exe'
$description = "Signal-C development checkout: $repoRoot"
$helperHeader = "' $description"

foreach ($requiredFile in @($launcher, $icon, $scriptHost)) {
	if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
		throw "A required launcher file is missing: $requiredFile"
	}
}
if ((Test-Path -LiteralPath $helper) -and (Get-Content -LiteralPath $helper -TotalCount 1) -ne $helperHeader) {
	throw "The launcher helper already exists and does not belong to this shortcut: $helper"
}

$shell = New-Object -ComObject WScript.Shell
try {
	$programs = $shell.SpecialFolders.Item('Programs')
	$shortcutPath = Join-Path $programs 'Signal-C (Development).lnk'
	$shortcut = $shell.CreateShortcut($shortcutPath)
	try {
		if ((Test-Path -LiteralPath $shortcutPath) -and $shortcut.Description -ne $description) {
			throw "An unrelated Start menu shortcut already uses this name: $shortcutPath"
		}
		# WScript hides only Node's console. The existing launcher opens the normal Agents window.
		$command = '"' + $nodeCommand.Source + '" "' + $launcher + '"'
		$escapedCommand = $command.Replace('"', '""')
		$helperSource = @"
$helperHeader
Option Explicit
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "$escapedCommand", 0, False
"@
		New-Item -ItemType Directory -Path (Split-Path -Parent $helper) -Force | Out-Null
		[IO.File]::WriteAllText($helper, $helperSource, [Text.UnicodeEncoding]::new($false, $true))
		$shortcut.TargetPath = $scriptHost
		$shortcut.Arguments = '"' + $helper + '"'
		$shortcut.WorkingDirectory = $repoRoot
		$shortcut.IconLocation = "$icon,0"
		$shortcut.Description = $description
		$shortcut.Save()
		Write-Output "Created Start menu entry: Signal-C (Development)"
		Write-Output $shortcutPath
	} finally {
		[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) | Out-Null
	}
} finally {
	[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) | Out-Null
}
