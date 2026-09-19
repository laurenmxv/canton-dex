import type { SnapTarget } from './types';

/**
 * The published Canton Snap, pinned.
 *
 * This is what a real reader installs. Both the install request and every
 * invocation name one exact id and one exact version, and nothing falls back
 * to another snap or another version.
 */
export const PUBLISHED_SNAP_ID = 'npm:@chainsafe/canton-snap';
export const SNAP_VERSION = '1.0.0';

export const PUBLISHED_SNAP: SnapTarget = {
  snapId: PUBLISHED_SNAP_ID,
  version: SNAP_VERSION,
  local: false,
};

/**
 * A development server on this machine, and nothing else.
 *
 * MetaMask derives a Snap's keys from its id, so the id is an identity, not an
 * address. A remote one would put that identity on a host we do not control,
 * which is why only loopback is accepted, and only while developing.
 */
const LOOPBACK_SNAP = /^local:http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;

/**
 * Which Snap this build installs.
 *
 * An unset or published id gives the published Snap. Anything else has to be a
 * loopback development Snap in a development build. A value that is neither is
 * a configuration mistake, and it stops the build rather than quietly becoming
 * one of the two.
 */
export function resolveSnapTarget(configured: string | undefined, development: boolean): SnapTarget {
  const wanted = configured?.trim();
  if (wanted === undefined || wanted === '' || wanted === PUBLISHED_SNAP_ID) return PUBLISHED_SNAP;
  if (!development) {
    throw new TypeError(
      `VITE_SNAP_ID names a development Snap, and this is not a development build: "${wanted}".`,
    );
  }
  if (!LOOPBACK_SNAP.test(wanted)) {
    throw new TypeError(
      `VITE_SNAP_ID must be "${PUBLISHED_SNAP_ID}" or a loopback development Snap written exactly as "local:http://localhost:4040", with no trailing slash: "${wanted}".`,
    );
  }
  return { snapId: wanted, version: SNAP_VERSION, local: true };
}
