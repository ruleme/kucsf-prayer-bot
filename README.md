# Amharic fellowship prayer bot

This is a local prototype for synthetic requests. Run one instance with Node.js 24 or later. It uses Telegram long polling and a local SQLite database. It has no package dependencies.

## Test setup

On Windows, double-click **Start test bot.cmd** in this folder for guided setup. It prompts privately for the token and channel ID and creates a Windows-protected local data key. Keep `.test-data-key` with its original Windows user account and use the same file when reopening the test database. Stop any previous instance with **Ctrl+C** before restarting.

To save the launcher's defaults, copy `test-settings.example.json` to `test-settings.json` and replace the placeholders. Keep local settings, bot tokens, encryption keys and prayer databases out of Git.

1. Create a dedicated test bot through Telegram's BotFather. Create a separate private test channel with no public username or linked discussion. Add the bot as an administrator with permission to post.
2. Enter the channel ID in the launcher, or leave it blank to discover it through a test post. For manual startup, set these variables in the terminal that will run the bot.

   ```powershell
   $env:BOT_TOKEN = Read-Host 'Test bot token' -MaskInput
   $env:CHANNEL_ID = Read-Host 'Private test channel ID (starts with -100)'
   $env:DATA_KEY = Read-Host 'Existing 64-digit hexadecimal data key' -MaskInput
   node bot.mjs
   ```

   To generate a data key once, run `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` in a private terminal. Save the key in a password manager and reuse it on restart. Keep it separate from the database. Run from the same working directory each time or set `DB_PATH` to an absolute location. Use a dedicated bot without an existing webhook.

3. Open **http://127.0.0.1:8787** in your browser on the same computer. Sign in as `moderator` using the panel password printed in the bot window. The password changes each time you restart. A Telegram moderator ID is no longer needed.
4. Send a sample Amharic request in Telegram. Refresh the panel with **ያድሱ**, select **ይፍቀዱ እና ያጋሩ**, and check that the private channel post contains only the request and a random reference. Repeat with rejection and withdrawal.
5. If sending is uncertain, the panel shows the reference under **ያልተረጋገጡ ልጥፎች**. Check the channel and record the outcome before closing the check. The bot never automatically resends an uncertain publication.

## Prototype boundaries

The prototype uses the same bot for intake and publication. Moderators access the password-protected panel from the computer running the bot. The panel shows request text without sender details. Approval publishes the submitted text as shown, so reject any request containing identifying details. Drafts are in memory and disappear on restart. Pending requests expire locally after seven days. A test channel administrator handles removal of published posts.

Before collecting real requests, add individual moderator accounts and redaction, establish removal and safeguarding procedures, and deploy with monitored secrets, retention, and recovery controls.

## Open moderation inside Telegram

On Windows, if ngrok is configured for the saved test URL, close any existing bot and ngrok instances and run **Start Telegram test.cmd**. This launches both processes. Leave the launcher window open during the test.

The optional Mini App uses the same queue and approval flow as the local panel. Once its public HTTPS address is set up, start **Start test bot.cmd**, enter that address at the Mini App prompt, and enter the numeric Telegram IDs allowed to moderate. Leave the address blank to use the local panel. The launcher does not provision HTTPS hosting.

For hosting or manual startup:

- Set `MINI_APP_ORIGIN` to the public HTTPS origin for the Mini App, such as `https://moderation.example.com`. Configure its HTTPS reverse proxy to forward only `/mini` and `/mini/*` to the bot's local panel on `127.0.0.1:8787` (or the configured `PANEL_PORT`). Preserve the public Host header, use a dedicated origin, and disable caching. Keep the local password-protected routes off the public proxy. Do not log authorization headers or response bodies.
- Set `MODERATOR_IDS` to the comma-separated numeric Telegram user IDs allowed to moderate. Supply both variables to the bot process and restart it. The Windows launcher uses either inherited settings or the values entered at its prompts.
- From an allowed account, tap **አስተባባሪ** beside the message box in the private bot chat. If the menu has not appeared yet, send `/start` to retry setup and receive the welcome shortcut. `/moderator` also sends the shortcut. The server checks Telegram's signed launch data and the user ID before returning requests or accepting actions. Reopen the Mini App from Telegram when the 15-minute authorization window expires.
- Moderators can tap **አዲስ የጸሎት ጥያቄ** in the Mini App to return to the bot chat and start a request. Anyone can send `/prayer` in the private bot chat to start the same flow.
- Test the button and posting from a moderator account in Telegram and verify that a regular account cannot open the queue. Only one bot polling process should run for a given token.
