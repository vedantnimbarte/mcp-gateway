import { McpError } from "@modelcontextprotocol/sdk/types.js";

/** SPEC §9. The JSON-RPC codes the gateway adds on top of the standard ones. */
export const ERR = {
  TIMEOUT: -32002,
  BACKEND_DOWN: -32003,
  POLICY: -32004,
  RATE_LIMITED: -32005,
  UNROUTABLE: -32006,
} as const;

export interface ErrorData {
  reason: string;
  server?: string;
  tool?: string;
  profile?: string;
  retry_after_ms?: number;
  /** A wrapped backend error, never swallowed (SPEC §9). */
  upstream?: { code: number; message: string };
}

export function gwError(code: number, message: string, data: ErrorData): McpError {
  return new McpError(code, message, data);
}
