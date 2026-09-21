import venueMark from '../assets/venue-mark.svg';

/**
 * Venue mark drawn in the three OpenZeppelin brand blues
 * (#475AFF, #2E99FF, #09C2FF), matching their logo's tonal ramp.
 */
export function Mark() {
  return <img className="size-6 flex-none" src={venueMark} alt="Canton DEX" />;
}
