// Runs before `npm run build`. Fleetbot <= v0.2 (this project's former name) updates by
// building in /opt/fleetbot/app.new. This version renames every path, user and command, so
// that old updater would swap in a build it cannot run. Stop it here: the old updater then
// leaves the running panel untouched, and the message tells the operator what to do.
import path from 'node:path';

const cwd = path.resolve(process.cwd()).replace(/\\/g, '/');
if (cwd.startsWith('/opt/fleetbot/')) {
  console.error(`
==========================================================================
 Fleetbot is now FleetPanel. This version cannot be installed by
 'fleetbot update'. Nothing was changed; the panel is still running.

 Upgrade (bots, data and settings are migrated in place) by running:

   curl -fsSL https://raw.githubusercontent.com/NexusGuide/FleetPanel/main/install.sh | sudo bash
==========================================================================
`);
  process.exit(1);
}
