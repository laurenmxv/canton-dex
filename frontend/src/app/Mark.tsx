/**
 * Venue mark drawn in the three OpenZeppelin brand blues
 * (#475AFF, #2E99FF, #09C2FF), matching their logo's tonal ramp.
 */
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" role="img" aria-label="Canton DEX">
      <path d="M4 3h16l-4.2 5.4H4Z" fill="#475AFF" />
      <path d="M9 9.3h11l-9 5.4H4.6Z" fill="#2E99FF" />
      <path d="M4 15.6h16L15.8 21H4Z" fill="#09C2FF" />
    </svg>
  );
}
