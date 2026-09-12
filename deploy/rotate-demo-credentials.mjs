/**
 * Replaces the seed's published demo passwords with generated ones.
 *
 * The seed is a development fixture: its credentials are printed in the repo
 * and in its own output. This host is reachable from the public internet, so
 * those accounts are rotated the moment the seed has run. Manager and employee
 * are additionally suspended - they exist to demonstrate scoping, and nobody
 * should be signing in as them here.
 *
 * The new admin password is written to a root-only file, never to stdout.
 */
import { PrismaClient } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';

const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const prisma = new PrismaClient();

const strong = () => randomBytes(24).toString('base64url').slice(0, 28);

try {
  const adminPassword = strong();
  const admin = await prisma.user.update({
    where: { id: (await prisma.user.findFirstOrThrow({ where: { email: 'admin@hrms.local' } })).id },
    data: { passwordHash: await hash(adminPassword, OPTIONS), mustChangePassword: true },
  });

  for (const email of ['manager@hrms.local', 'employee@hrms.local']) {
    const user = await prisma.user.findFirst({ where: { email } });
    if (!user) continue;
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hash(strong(), OPTIONS), status: 'SUSPENDED' },
    });
    console.log(`rotated + suspended: ${email}`);
  }

  const out = '/run/secrets-out/hrms-admin-credentials.txt';
  writeFileSync(
    out,
    [
      'HRMS initial administrator credentials',
      `generated ${new Date().toISOString()}`,
      '',
      `url       https://hrms.gamempires.com`,
      `email     ${admin.email}`,
      `password  ${adminPassword}`,
      '',
      'This account is flagged mustChangePassword. Change it on first sign-in',
      'and then delete this file.',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  chmodSync(out, 0o600);
  console.log(`rotated: ${admin.email} (mustChangePassword=true)`);
  console.log('credentials written to host file, not printed');
} finally {
  await prisma.$disconnect();
}
