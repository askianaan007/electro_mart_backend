/**
 * Runs in every test worker before any module loads: point Prisma at the
 * verified test database (globalSetup already proved it carries the marker)
 * and blank out anything that could reach an external service.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is not set');
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'integration-test-secret-0123456789abcdef';
process.env.CLOUDINARY_CLOUD_NAME = 'test';
process.env.CLOUDINARY_API_KEY = 'test';
process.env.CLOUDINARY_API_SECRET = 'test';
process.env.SMTP_HOST = '';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
