export function recordValue<T>(
  values: Record<string, T>,
  key: string,
): T | undefined {
  return values[key];
}
