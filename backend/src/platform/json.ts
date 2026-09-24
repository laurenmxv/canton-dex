declare global {
  interface JSON {
    /** A value that `JSON.stringify` writes as the given JSON text. */
    rawJSON(text: string): unknown;
  }
}

/** JSON text in which a bigint, such as an int64 offset, is a number literal with every digit. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item,
  );
}
