import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = ' electromarttrade@gmail.com';
  const plainPassword = 'Aa@amjaskmub077';

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