import { Prisma } from '@prisma/client';

/**
 * The only Dealer columns a representative may ever receive. Explicit
 * allow-list (not an omit) so credentials, reset tokens, the login username
 * and credit internals can never leak through a rep-facing response — and a
 * newly-added Dealer column stays hidden until it's deliberately listed here.
 * (Credit figures are surfaced intentionally only by
 * RepCollectionsService.getCustomerCollectionsSummary.)
 */
export const REP_SAFE_DEALER_SELECT = {
  id: true,
  businessName: true,
  ownerName: true,
  phone: true,
  email: true,
  address: true,
  district: true,
  status: true,
  source: true,
  createdByRepId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DealerSelect;
