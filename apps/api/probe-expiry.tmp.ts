import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'employee@hrms.local' } });
  const raw = `prisma-expiry-probe-${Date.now()}`;
  const tokenHash = createHash('sha256').update(raw).digest('hex');

  // Written exactly the way the application writes it: a JS Date via Prisma.
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
    },
  });

  const back = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
  console.log('TOKEN=' + raw);
  console.log('expiresAt(read back) =', back.expiresAt.toISOString());
  console.log('now                  =', new Date().toISOString());
  console.log('app sees it expired  =', back.expiresAt <= new Date());
}

main().finally(() => void prisma.$disconnect());
