import { Type, type StaticDecode, type TProperties, type TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { bool, enumeration, int, list, long, parseJson, present, text, type JsonObject } from './request.js';

/** Reads JSON that a store wrote. A value it cannot read is a server error, not a bad request. */
export function stored<T>(column: string, json: string, read: (value: unknown) => T | null): T {
  try {
    const value = read(parseJson(json));
    if (value !== null) return value;
  } catch (error) {
    throw new Error(`Stored ${column} is invalid`, { cause: error });
  }
  throw new Error(`Stored ${column} is missing`);
}

/** A stored text field that must have a value; it has the scalar forms that `text` reads. */
export const storedText = Type.Decode(Type.Unknown(), (value) => present(text(value), 'text'));

/** Missing or null stored text stays null. */
export const storedNullableText = Type.Decode(Type.Unknown({ default: null }), text);

/** A stored 64-bit integer, decoded without losing precision. */
export const storedLong = Type.Decode(Type.Unknown(), (value) => present(long(value), 'integer'));

/** A stored boolean with the same scalar forms as the request reader. */
export const storedBool = Type.Decode(Type.Unknown(), (value) => present(bool(value), 'boolean'));

/** A stored 32-bit integer field that must have a value. */
export const storedInt = Type.Decode(Type.Unknown(), (value) => present(int(value), 'integer'));

/** A stored enum field that must have a value: a constant name or its ordinal. */
export function storedEnum<T extends string>(names: readonly T[]) {
  return Type.Decode(Type.Unknown(), (value) => present(enumeration(value, names), 'enum constant'));
}

/** Stored lists must be arrays. An explicit default handles both missing and null values. */
export function storedList<Schema extends TSchema>(schema: Schema, defaultValue?: readonly StaticDecode<Schema>[]) {
  const input = Type.Unknown(defaultValue === undefined ? {} : { default: null });
  return Type.Decode(input, (value): readonly StaticDecode<Schema>[] =>
    present(list(value, (item) => Value.Decode(schema, item)) ?? defaultValue?.slice() ?? null, 'list'),
  );
}

/**
 * A stored JSON object with readonly fields. JSONB returns keys in its own order, so the decoded
 * object has exactly these properties, in their declaration order.
 */
export function storedObject<Properties extends TProperties>(properties: Properties) {
  return Type.Decode(Type.ReadonlyObject(Type.Object(properties)), (fields) => {
    const values = fields as JsonObject;
    return Object.fromEntries(Object.keys(properties).map((key) => [key, values[key]])) as typeof fields;
  });
}
