import { plainToInstance } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Fail fast at startup if required configuration is missing, instead of
 * limping along with `undefined` secrets/connection strings that only
 * surface as confusing runtime errors later (e.g. a JWT secret of
 * `undefined` silently accepted by passport-jwt).
 */
class EnvironmentVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_URL: string;

  @IsString()
  @IsNotEmpty()
  DIRECT_URL: string;

  // Signs every access token issued for both roles — a short/guessable
  // secret is brute-forceable offline, letting an attacker forge tokens
  // (including admin ones) for full account takeover. 32 chars is a floor,
  // not a target; generate this with something like `openssl rand -hex 32`.
  @IsString()
  @IsNotEmpty()
  @MinLength(32)
  JWT_SECRET: string;

  @IsOptional()
  @IsString()
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsString()
  JWT_REFRESH_EXPIRES_IN_DAYS?: string;

  @IsOptional()
  @IsString()
  PORT?: string;

  // SMTP is intentionally optional — MailerService degrades gracefully
  // (logs a warning and skips sending) when it isn't configured.
  @IsOptional()
  @IsString()
  SMTP_HOST?: string;

  @IsOptional()
  @IsString()
  SMTP_PORT?: string;

  @IsOptional()
  @IsString()
  SMTP_USER?: string;

  @IsOptional()
  @IsString()
  SMTP_PASS?: string;

  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  // Comma-separated list of allowed origins for CORS. Falls back to a
  // permissive dev-friendly default (see main.ts) if unset.
  @IsOptional()
  @IsString()
  CORS_ORIGIN?: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_CLOUD_NAME: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_API_KEY: string;

  @IsString()
  @IsNotEmpty()
  CLOUDINARY_API_SECRET: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => Object.values(error.constraints ?? {}).join(', '))
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return validatedConfig;
}
