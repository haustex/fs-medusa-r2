const MASK = "••••"
// Below this length the last 4 characters are too large a share of the secret.
const MIN_LENGTH_TO_REVEAL = 12

/** Masks a credential for display: the last 4 characters only, e.g. "••••a1b2". */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  if (value.length < MIN_LENGTH_TO_REVEAL) {
    return MASK
  }
  return `${MASK}${value.slice(-4)}`
}
