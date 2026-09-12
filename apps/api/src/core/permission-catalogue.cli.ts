/**
 * Runs the permission catalogue sync by hand.
 *
 * The API does this at boot, so this exists for the case where you want it
 * without a restart - after editing the catalogue in development, or to repair
 * an installation whose API is up and whose grants are stale.
 *
 *   npm run db:sync-permissions
 *
 * In a built image, where the sources are not present:
 *
 *   node dist/core/permission-catalogue.cli.js
 */
import { prisma } from './db.js';
import { syncPermissionCatalogue } from './permission-catalogue.js';

try {
  const { permissionsAdded, grantsAdded } = await syncPermissionCatalogue();

  for (const { role, permissions } of grantsAdded) {
    console.log(`  ${role}: granted ${permissions.join(', ')}`);
  }

  console.log(`\npermissions added: ${permissionsAdded.length}`);
  console.log(`grants added:      ${grantsAdded.reduce((n, g) => n + g.permissions.length, 0)}`);
} finally {
  await prisma.$disconnect();
}
