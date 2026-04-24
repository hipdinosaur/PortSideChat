import type { VercelRequest, VercelResponse } from '@vercel/node';

export const config = {
    api: { bodyParser: false },
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const slug = (req.query.path as string[]).join('/');
    const target = `https://api.anthropic.com/${slug}`;

    const headers: Record<string, string> = {
        'content-type': req.headers['content-type'] ?? 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
        'anthropic-version': (req.headers['anthropic-version'] as string) ?? '2023-06-01',
    };

    if (req.headers['anthropic-beta']) {
        headers['anthropic-beta'] = req.headers['anthropic-beta'] as string;
    }

    const body = ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : req;

    const upstream = await fetch(target, {
        method: req.method,
        headers,
        body: body as BodyInit,
        // @ts-expect-error — Node 18 fetch needs this to stream a request body
        duplex: 'half',
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
        if (!['content-encoding', 'transfer-encoding'].includes(key)) {
            res.setHeader(key, value);
        }
    });

    const reader = upstream.body?.getReader();
    if (!reader) return res.end();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
    }
    res.end();
}
