export class RemoteError extends Error {
  constructor(
    public status: number,
    public code: string,
    public body: any,
  ) {
    super(body?.error?.message ?? body?.message ?? code);
  }
}
export async function remote(
  base: string,
  path: string,
  body?: unknown,
  timeout = 12000,
) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await response.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new RemoteError(response.status, "BAD_JSON", { raw });
  }
  if (!response.ok)
    throw new RemoteError(
      response.status,
      data.error?.code ?? data.code ?? "SERVICE_UNAVAILABLE",
      data.error ?? data,
    );
  return data;
}
export const gateway = (path: string, body?: unknown) =>
  remote(process.env.GATEWAY_URL ?? "http://localhost:3100", path, body);
