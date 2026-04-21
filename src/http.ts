import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export function ok<T extends Record<string, unknown>>(c: Context, result: T) {
  return c.json({ ok: true, result });
}

export function okRaw(c: Context, result: unknown) {
  return c.json({ ok: true, result });
}

export function tgError(
  c: Context,
  description: string,
  error_code: number = 400,
  status: ContentfulStatusCode = 400,
) {
  return c.json({ ok: false, error_code, description }, status);
}

export async function parseTelegramBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const raw = await c.req.text();
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await c.req.text();
    const params = new URLSearchParams(raw);
    const result: Record<string, unknown> = {};
    for (const [key, value] of params) {
      result[key] = tryParseJsonScalar(value);
    }
    return result;
  }

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const result: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value !== "string" && typeof (value as File).arrayBuffer === "function") {
        const file = value as File;
        const bytes = Buffer.from(await file.arrayBuffer());
        result[key] = { __file: true, name: file.name, type: file.type, bytes };
      } else {
        result[key] = tryParseJsonScalar(String(value));
      }
    }
    return result;
  }

  return {};
}

function tryParseJsonScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const first = trimmed[0];
  if (first === "{" || first === "[" || first === '"' || trimmed === "true" || trimmed === "false" || /^-?\d/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}
