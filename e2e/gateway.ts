import { expect } from 'vitest';

export async function gateway(url: string) {
  const exchange = await fetch(url, { redirect: 'manual' });
  const cookie = exchange.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  expect(cookie).not.toBe('');
  const origin = new URL(url).origin;
  const page = await fetch(origin, { headers: { cookie } });
  const html = await page.text();
  expect(html).toContain('@wahhheee/dsh-stash');
  return async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
    const response = await fetch(origin + '/api/' + method, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: method,
        method,
        payload: { args },
      }),
    });
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      type: string;
      result: { ok: boolean; value: T };
    };
    expect(envelope.type).toBe('server-response');
    expect(envelope.result.ok, JSON.stringify(envelope)).toBe(true);
    return envelope.result.value;
  };
}
