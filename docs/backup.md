# Backups and disaster recovery

FleetPanel keeps two kinds of backups apart:

| What | Contains | Where |
| --- | --- | --- |
| **Panel backup** (`.fleet`, encrypted) | The panel database: administrators, bots and their settings, encrypted bot secrets, audit log, panel settings; and the master key | Telegram (scheduled), or *Settings → Download* |
| **Bot backups** | One bot's files and database | *Instances → Backup* (on the server), and each bot's own backup feature |

The panel backup does not copy the bots' data: the bots back themselves up and send their database
backups to Telegram, and those backups are restored with **Import database** after the panel is back.

MirzaBot and Faoxima send their backups from their cron jobs, which FleetPanel runs since v0.4.2 (see
[providers.md](providers.md#cron-jobs-of-php-bots)); set the backup chat in each bot's admin menu.
PasarguardBot schedules its own backups.

## Telegram backup

*Settings → Telegram backup* (Owner only):

1. Create a bot with @BotFather for backups (do not reuse a bot that FleetPanel hosts) and add it to a
   private chat, group or channel. The **Chat ID** is that chat's numeric id (`-100…` for groups and
   channels) or `@channelname`; **Topic ID** picks a topic in a forum group.
2. Choose a **recovery passphrase** (12+ characters) and keep it in a password manager.
3. Pick a schedule (hourly, every 6 hours, daily), enable it, **Save**, then **Send test message** and
   **Back up now**.

Backups are sent only when something changed since the last one, and at least once a day. *Download*
gives you a fresh `.fleet` file in the browser.

### Encryption

Each `.fleet` file is encrypted with AES-256-GCM using a key agreed with X25519 between a one-off key and
the panel's backup public key. The matching private key travels inside every file, encrypted with a key
derived from the recovery passphrase (scrypt, 64 MiB). The server stores only the public key and that
passphrase-protected private key, never the passphrase. So:

- the Telegram chat, or anyone who copies the files, cannot open them without the passphrase;
- a compromised server cannot decrypt the backups already sent;
- restoring needs only the file and the passphrase.

Changing the passphrase applies to new backups; older files still open with the old passphrase.
Login sessions are left out of backups.

## Restoring on a new server

1. Install FleetPanel on the new server (`install.sh`). Use the same panel domain if you had one.
2. Download the newest `.fleet` file from the Telegram chat and copy it to the server
   (e.g. `scp fleetpanel-….fleet root@NEW-SERVER:`).
3. Restore it and enter the recovery passphrase:

   ```bash
   sudo fleetpanel restore fleetpanel-vps-20261003T040000Z.fleet
   ```

   Administrators, bots and their settings come back; the old administrator passwords apply again.
4. Point each bot's domain at the new server, then press **Repair** on each bot. Bots whose files are not
   on the server are marked with *"The bot is not installed on this server"*. Repair reinstalls the pinned
   bot version with the stored token, settings and database credentials, creates the database, the site
   and the certificate.
5. Bring back each bot's data: in the bot's details, **Import database** with the bot's own backup.

## Import database

*Instances → (bot) → Backups → Import database* (needs the *backups.restore* permission) replaces a bot's
database with a dump of it:

- `.sql`, `.sql.gz`, or a `.zip` containing exactly one `.sql` (the bots' own backups are such zips),
  up to 512 MB;
- a safety backup of the current state is taken first, and the bot is stopped during the import;
- the dump is checked and rewritten before import: mysql client commands (`\!`, `system`) are refused,
  `CREATE DATABASE` / `USE` lines are dropped so the data always lands in this bot's database, and
  `DEFINER` clauses are removed; the import runs as the bot's own database user with `--binary-mode`;
- afterwards FleetPanel reapplies what it manages: the schema script (PHP bots) or migrations (Python
  bots), MirzaBot's webhook secret and the Telegram webhook.

If an import fails, the previous database is in the safety backup (*Backups → Restore*).
