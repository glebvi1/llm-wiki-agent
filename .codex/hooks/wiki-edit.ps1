$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

try {
    # Consume the event payload; the editorial rule applies to every prompt.
    $null = [Console]::In.ReadToEnd()
    $projectRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
    $skillPath = Join-Path $projectRoot '.agents/skills/wiki-edit/SKILL.md'
    $skill = [System.IO.File]::ReadAllText($skillPath, $utf8)
    $body = [regex]::Replace($skill, '(?s)\A---\r?\n.*?\r?\n---\r?\n', '').Trim()
    if ([string]::IsNullOrWhiteSpace($body)) {
        throw 'The wiki-edit skill is empty.'
    }
    $result = @{
        hookSpecificOutput = @{
            hookEventName = 'UserPromptSubmit'
            additionalContext = $body
        }
    }
} catch {
    $message = 'The required wiki-edit hook failed. Tell Gleb briefly in Russian; read .agents/skills/wiki-edit/SKILL.md and apply it before replying. If that file is unavailable, report that the editorial check could not be completed. Error: ' + $_.Exception.Message
    $result = @{
        systemMessage = $message
        hookSpecificOutput = @{
            hookEventName = 'UserPromptSubmit'
            additionalContext = $message
        }
    }
}

[Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 4 -Compress))
exit 0
