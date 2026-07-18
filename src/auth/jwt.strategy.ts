import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { AccountStatus, Role } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../common/interfaces/jwt-payload.interface';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') as string,
    });
  }

  /**
   * A signature-valid token alone isn't enough to trust — without this,
   * deactivating a dealer (e.g. for a payment dispute) has no effect on an
   * access token they already hold, which stays usable for the rest of its
   * lifetime (up to JWT_EXPIRES_IN). Re-checking status here on every
   * authenticated request closes that gap at the cost of one indexed
   * lookup per request.
   */
  async validate(payload: JwtPayload): Promise<JwtPayload> {
    if (payload.role === Role.DEALER) {
      const dealer = await this.prisma.dealer.findUnique({
        where: { id: payload.sub },
        select: { status: true },
      });
      if (!dealer || dealer.status !== AccountStatus.ACTIVE) {
        throw new UnauthorizedException('Account is inactive');
      }
    }
    return payload;
  }
}
