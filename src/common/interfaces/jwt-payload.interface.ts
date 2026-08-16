export interface JwtPayload {
  sub: string;
  role: 'ADMIN' | 'DEALER' | 'REPRESENTATIVE';
  email?: string;
  username?: string;
}
