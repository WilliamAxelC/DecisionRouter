import type { ProviderConfig } from "../config/schema.js";
import type {
  CanonicalRequest,
  CanonicalResponse,
  CanonicalStreamEvent,
} from "../types/ir.js";

export type UpstreamResult =
  | { kind: "response"; response: CanonicalResponse }
  | { kind: "stream"; stream: AsyncIterable<CanonicalStreamEvent> };

export class UpstreamError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly provider: string;
  readonly model: string;

  constructor(opts: {
    status: number;
    retryable: boolean;
    provider: string;
    model: string;
    message: string;
  }) {
    super(opts.message);
    this.name = "UpstreamError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.provider = opts.provider;
    this.model = opts.model;
  }
}

export interface UpstreamAdapter {
  send(
    req: CanonicalRequest,
    providerName: string,
    providerConfig: ProviderConfig,
    model: string,
  ): Promise<UpstreamResult>;
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function joinUrl(baseUrl: string, suffix: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedSuffix = suffix.replace(/^\/+/, "");
  return `${trimmedBase}/${trimmedSuffix}`;
}
