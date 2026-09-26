import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from "axios";
import type { FrameworkEnv } from "../config/env.js";

/** A recorded request/response pair for evidence and contract checks. */
export interface RecordedCall {
  method: string;
  url: string;
  status: number;
  requestBody?: unknown;
  responseBody?: unknown;
  durationMs: number;
  featureId?: string;
  behaviourId?: string;
}

/** Thin per-service API client: auth header, call recording, envelope unwrap. */
export class ApiClient {
  readonly http: AxiosInstance;
  private readonly recordings: RecordedCall[] = [];
  private recording = false;
  private context: { featureId?: string; behaviourId?: string } = {};

  constructor(baseURL: string, private readonly tokenProvider?: () => string | undefined) {
    this.http = axios.create({ baseURL, timeout: 30_000, validateStatus: () => true });
    this.http.interceptors.request.use((config) => {
      const token = this.tokenProvider?.();
      if (token) {
        config.headers = config.headers ?? {};
        (config.headers as Record<string, string>).Authorization = `Bearer ${token}`;
      }
      (config as { __startedAt?: number }).__startedAt = Date.now();
      return config;
    });
    this.http.interceptors.response.use((response) => {
      if (this.recording) {
        const started = (response.config as { __startedAt?: number }).__startedAt;
        this.recordings.push({
          method: (response.config.method ?? "get").toUpperCase(),
          url: `${response.config.baseURL ?? ""}${response.config.url ?? ""}`,
          status: response.status,
          requestBody: response.config.data,
          responseBody: response.data,
          durationMs: started ? Date.now() - started : 0,
          ...this.context,
        });
      }
      return response;
    });
  }

  record(featureId: string, behaviourId: string): () => RecordedCall[] {
    this.context = { featureId, behaviourId };
    this.recording = true;
    const at = this.recordings.length;
    return () => {
      this.recording = false;
      this.context = {};
      return this.recordings.slice(at);
    };
  }

  get<T = unknown>(url: string, cfg?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.get<T>(url, cfg);
  }
  post<T = unknown>(url: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.post<T>(url, body, cfg);
  }
  put<T = unknown>(url: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.put<T>(url, body, cfg);
  }
  patch<T = unknown>(url: string, body?: unknown, cfg?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.patch<T>(url, body, cfg);
  }
  delete<T = unknown>(url: string, cfg?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.http.delete<T>(url, cfg);
  }

  static unwrap<T = unknown>(res: AxiosResponse<unknown>): T {
    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} for ${res.config.url}: ${JSON.stringify(res.data)}`);
    }
    const body = res.data as { success?: boolean; data?: T; error?: string } | undefined;
    if (body && typeof body === "object" && "success" in body) {
      if (!body.success) throw new Error(`API error: ${body.error ?? "unknown"}`);
      return body.data as T;
    }
    return body as unknown as T;
  }
}

export function serviceClient(env: FrameworkEnv, service: string, tokenProvider?: () => string | undefined): ApiClient {
  const url = env.services[service];
  if (!url) throw new Error(`No base URL configured for service "${service}"`);
  return new ApiClient(url, tokenProvider);
}