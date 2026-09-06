import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FAKE_IP_DOH_URL, isProxyFakeIpAddress, resolvePublicAddresses } from '@deepseek-ai/dsh-web-fetch-http';

describe('DeepSeek Harness web fetch fake-IP resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves RFC 2544 proxy fake IPs through the configured fixed-IP DoH endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ Answer: [{ type: 1, data: '103.235.46.102' }] }), { status: 200 })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ Answer: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolvePublicAddresses(
      'www.baidu.com',
      new AbortController().signal,
      async () => [{ address: '198.18.0.113', family: 4 }],
      DEFAULT_FAKE_IP_DOH_URL
    );

    expect(result).toEqual([{ address: '198.18.0.113', family: 4 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not send ordinary private addresses to the external resolver', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      resolvePublicAddresses(
        'internal.example',
        new AbortController().signal,
        async () => [{ address: '127.0.0.1', family: 4 }],
        DEFAULT_FAKE_IP_DOH_URL
      )
    ).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-public addresses returned by DoH', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ Answer: [{ type: 1, data: '127.0.0.1' }] }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ Answer: [] }), { status: 200 }))
    );

    await expect(
      resolvePublicAddresses(
        'malicious.example',
        new AbortController().signal,
        async () => [{ address: '198.19.255.255', family: 4 }],
        DEFAULT_FAKE_IP_DOH_URL
      )
    ).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' });
  });

  it('recognizes only the complete proxy fake-IP range', () => {
    expect(isProxyFakeIpAddress('198.18.0.0')).toBe(true);
    expect(isProxyFakeIpAddress('198.19.255.255')).toBe(true);
    expect(isProxyFakeIpAddress('198.20.0.0')).toBe(false);
  });
});
