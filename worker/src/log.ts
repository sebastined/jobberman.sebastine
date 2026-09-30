// Structured JSON logs: searchable and filterable in Workers Logs, with the right severity per level.

type Fields = Record<string, unknown>;

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function logInfo(message: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ message, ...fields }));
}

export function logWarn(message: string, fields: Fields = {}): void {
  console.warn(JSON.stringify({ message, ...fields }));
}

export function logError(message: string, fields: Fields = {}): void {
  console.error(JSON.stringify({ message, ...fields }));
}
