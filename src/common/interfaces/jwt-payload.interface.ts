export interface JwtPayload {
  sub: string;
  role: 'ADMIN' | 'DEALER';
  email?: string;
  username?: string;
}
