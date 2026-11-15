param([switch] $StartTunnel)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$tunnel = $null

function Unprotect-Value([Security.SecureString] $Value) {
    [System.Net.NetworkCredential]::new('', $Value).Password
}

function Invoke-Telegram([string] $Method, [hashtable] $Payload) {
    try {
        $response = Invoke-RestMethod -Method Post -TimeoutSec 15 -ContentType 'application/json' `
            -Uri "https://api.telegram.org/bot$($env:BOT_TOKEN)/$Method" `
            -Body (ConvertTo-Json -InputObject $Payload -Compress)
        if (-not $response.ok) { throw 'Telegram rejected the request.' }
        $response.result
    } catch {
        throw "Telegram could not complete $Method. Check your test token and internet connection. Use a dedicated bot that has no webhook and is not already running."
    }
}

function Select-Entry([string] $Label, [hashtable] $Entries) {
    foreach ($id in $Entries.Keys) {
        Write-Host "$id  $($Entries[$id])"
    }
    $selected = (Read-Host "Enter the ID for $Label").Trim()
    if (-not $Entries.ContainsKey($selected)) { throw 'The ID was not in the list.' }
    $selected
}

function Test-ExistingTunnel([string] $PublicUrl, [int] $Port) {
    try {
        $status = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2 -MaximumRedirection 0
        $localAddresses = @("http://127.0.0.1:${Port}", "http://localhost:${Port}", "127.0.0.1:${Port}", "localhost:${Port}")
        foreach ($entry in $status.tunnels) {
            if ($entry.public_url -eq $PublicUrl -and
                $entry.config.addr -in $localAddresses -and $entry.config.inspect -eq $false) {
                return $true
            }
        }
    } catch {
        # The local ngrok status service may be disabled.
    }
    return $false
}

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 or later first.' }
    $nodeVersion = & node --version
    if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 24) {
        throw 'Install Node.js 24 or later first.'
    }

    $env:BOT_TOKEN = (Unprotect-Value (Read-Host 'Paste your BotFather test token' -AsSecureString)).Trim()
    if ($env:BOT_TOKEN -notmatch '^\d+:[A-Za-z0-9_-]+$') { throw 'The token has an unexpected format.' }
    $bot = Invoke-Telegram 'getMe' @{}
    Write-Host "Connected to @$($bot.username)."
    $settings = $null
    $settingsPath = Join-Path $PSScriptRoot 'test-settings.json'
    if (Test-Path -LiteralPath $settingsPath) {
        $saved = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        if ($saved.botUsername -eq $bot.username) { $settings = $saved }
    }
    if ($settings.channelId) {
        $env:CHANNEL_ID = [string]$settings.channelId
        Write-Host "Using saved private channel ID $env:CHANNEL_ID."
    } else {
        $env:CHANNEL_ID = (Read-Host 'Enter your private channel ID, or press Enter to find it').Trim()
    }
    if (-not $env:CHANNEL_ID) {
        Invoke-Telegram 'getUpdates' @{allowed_updates = @('channel_post')} | Out-Null
        Write-Host 'In your private test channel, post this exact message: prayer bot test'
        Write-Host 'The bot must already be a channel administrator with permission to post.'
        $channels = @{}
        while ($channels.Count -eq 0) {
            if ((Read-Host 'Press Enter to look for the channel post, or type q to quit') -eq 'q') { return }
            $updates = Invoke-Telegram 'getUpdates' @{allowed_updates = @('channel_post')}
            foreach ($update in $updates) {
                if ($update.channel_post.chat.type -eq 'channel' -and $update.channel_post.text -eq 'prayer bot test') {
                    $channel = $update.channel_post.chat
                    $channels[[string]$channel.id] = $channel.title
                }
            }
            if ($channels.Count -eq 0) { Write-Host 'Still waiting for the test channel post.' }
        }
        $env:CHANNEL_ID = Select-Entry 'your private test channel' $channels
    }

    if (-not $env:MINI_APP_ORIGIN) {
        if ($settings.miniAppOrigin) {
            $env:MINI_APP_ORIGIN = [string]$settings.miniAppOrigin
        } else {
            $env:MINI_APP_ORIGIN = (Read-Host 'Enter the Mini App HTTPS address, or press Enter to use the local panel').Trim()
        }
    }
    if ($env:MINI_APP_ORIGIN) {
        $origin = $null
        if (-not [Uri]::TryCreate($env:MINI_APP_ORIGIN, [UriKind]::Absolute, [ref]$origin) -or
            $origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or
            $origin.AbsolutePath -notin @('/', '/mini', '/mini/')) {
            throw 'Enter the public HTTPS address of the Mini App or its hosting domain.'
        }
        $env:MINI_APP_ORIGIN = $origin.GetLeftPart([UriPartial]::Authority)
        if (-not $env:MODERATOR_IDS) {
            if ($settings.moderatorIds) {
                $env:MODERATOR_IDS = [string]$settings.moderatorIds
            } else {
                $env:MODERATOR_IDS = (Read-Host 'Enter the Telegram IDs allowed to moderate, separated by commas').Trim()
            }
        }
        if ($env:MODERATOR_IDS -notmatch '^\d+(\s*,\s*\d+)*$') {
            throw 'Enter one or more numeric Telegram user IDs for the moderator panel.'
        }
        Write-Host "From an approved Telegram account, send /moderator to @$($bot.username)."
    }

    if ($StartTunnel) {
        if (-not $origin -or $origin.Host -notmatch '\.ngrok-free\.(dev|app)$') {
            throw 'The combined launcher needs your ngrok HTTPS address.'
        }
        $port = 8787
        if ($env:PANEL_PORT -and (-not [int]::TryParse($env:PANEL_PORT, [ref]$port) -or $port -lt 1 -or $port -gt 65535)) {
            throw 'The panel port must be a number from 1 to 65535.'
        }
        if (Test-ExistingTunnel $env:MINI_APP_ORIGIN $port) {
            Write-Host "Using the existing ngrok connection for $env:MINI_APP_ORIGIN."
        } else {
            $ngrok = Get-Command ngrok -CommandType Application -ErrorAction SilentlyContinue
            if (-not $ngrok) { throw 'Install and configure ngrok before using this launcher.' }
            $start = New-Object System.Diagnostics.ProcessStartInfo
            $start.FileName = $ngrok.Source
            $start.Arguments = "http http://127.0.0.1:$port --url=$env:MINI_APP_ORIGIN --inspect=false --log=stderr --log-level=error"
            $start.UseShellExecute = $false
            $start.CreateNoWindow = $true
            $start.RedirectStandardError = $true
            $start.EnvironmentVariables.Remove('BOT_TOKEN')
            $start.EnvironmentVariables.Remove('DATA_KEY')
            $tunnel = [System.Diagnostics.Process]::Start($start)
            $tunnelErrors = $tunnel.StandardError.ReadToEndAsync()
            if ($tunnel.WaitForExit(2000)) {
                $failure = $tunnelErrors.GetAwaiter().GetResult()
                $code = [regex]::Match($failure, 'ERR_NGROK_\d+').Value
                if ($code -eq 'ERR_NGROK_334') {
                    throw 'This ngrok address is already online. Stop its existing ngrok session, or use Start test bot.cmd if the existing tunnel already forwards to this computer on the panel port.'
                }
                throw "ngrok could not start ($code). Check that ngrok is signed in."
            }
            Write-Host "Launched ngrok for $env:MINI_APP_ORIGIN."
        }
    }

    $keyPath = Join-Path $PSScriptRoot '.test-data-key'
    $env:DB_PATH = Join-Path $PSScriptRoot 'prayer-test.sqlite'
    if (-not (Test-Path -LiteralPath $keyPath)) {
        if (Test-Path -LiteralPath $env:DB_PATH) {
            throw 'The existing test database needs its original .test-data-key file.'
        }
        $bytes = New-Object byte[] 32
        $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $hex = [BitConverter]::ToString($bytes).Replace('-', '')
        ConvertFrom-SecureString (ConvertTo-SecureString $hex -AsPlainText -Force) |
            Set-Content -LiteralPath $keyPath -Encoding Ascii
    }
    $env:DATA_KEY = Unprotect-Value (ConvertTo-SecureString (Get-Content -LiteralPath $keyPath -Raw).Trim())
    Write-Host 'Starting the bot. Leave this window open while you test.'
    & node (Join-Path $PSScriptRoot 'bot.mjs')
} catch {
    Write-Host $_.Exception.Message
    exit 1
} finally {
    if ($tunnel) {
        if (-not $tunnel.HasExited) { $tunnel.Kill() }
        $tunnel.Dispose()
    }
    Remove-Item Env:BOT_TOKEN, Env:DATA_KEY -ErrorAction SilentlyContinue
}
