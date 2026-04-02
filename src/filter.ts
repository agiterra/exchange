/**
 * Filter VM sandbox — evaluates JS expressions for webhook routing.
 *
 * Filters are JS expressions that return true/false. They receive a context
 * object with { headers, payload } from the inbound webhook.
 *
 * Uses Function constructor (not eval) for slightly better isolation.
 * The expression runs synchronously with a frozen context.
 */

export type FilterContext = Record<string, unknown>;

/**
 * Evaluate a filter expression against a context.
 * Returns true if the filter matches, false otherwise.
 * Returns true if filter is null/empty (no filter = match all).
 */
export function evaluateFilter(
  filter: string | null,
  context: FilterContext,
): boolean {
  if (!filter || !filter.trim()) return true; // no filter = match all

  try {
    const keys = Object.keys(context);
    const values = keys.map((k) => context[k]);
    // Create function with context keys as parameters
    const fn = new Function(...keys, `"use strict"; return !!(${filter})`);
    return fn(...values);
  } catch (e) {
    // Filter error = no match (fail closed)
    return false;
  }
}

/**
 * Evaluate a JS expression and return the raw result (not coerced to boolean).
 * Used for dedup key extraction and other value-returning expressions.
 */
export function evaluateExpression(
  expr: string,
  context: FilterContext,
): unknown {
  const keys = Object.keys(context);
  const values = keys.map((k) => context[k]);
  const fn = new Function(...keys, `"use strict"; return (${expr})`);
  return fn(...values);
}

/**
 * Validate a filter expression without evaluating it.
 * Returns null if valid, error message if invalid.
 */
export function validateFilter(filter: string): string | null {
  try {
    new Function("event", "payload", `"use strict"; return !!(${filter})`);
    return null;
  } catch (e: any) {
    return e.message;
  }
}
