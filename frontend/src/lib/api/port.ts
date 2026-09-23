import type { DexClient as VenueClient } from '@canton-dex/client';

/**
 * The single seam between this webapp and everything behind it.
 *
 * It is exactly the surface the venue serves, so the real client is injected as
 * it is and the fixture implements the same shape. Screens and hooks depend
 * only on this: they know nothing about HTTP routes, credentials, Canton or
 * signing, and no method takes an actor, because the caller comes from the
 * token and, in the demo, from the actor the composition point bound.
 */
export type DexClient = VenueClient;
