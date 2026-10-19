import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { generateTempPassword } from '../src/common/utils/generate-password';

const prisma = new PrismaClient();

async function main() {
  const email = 'electromarttrade@gmail.com';
  // Never a password committed to the repo: set SEED_ADMIN_PASSWORD, or a
  // random one is generated and printed once below.
  const plainPassword =
    process.env.SEED_ADMIN_PASSWORD || generateTempPassword();

  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) {
    console.log('Admin already exists:', email);

    return;
  }

  const hashed = await bcrypt.hash(plainPassword, 10);

  const admin = await prisma.admin.create({
    data: {
      email,
      password: hashed,
      name: 'Electro Mart Owner',
    },
  });

  console.log('Admin created:');
  console.log('  email:', admin.email);
  console.log('  password (plain, change after first login):', plainPassword);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
