import { scriptTag } from 'virtual:dappfence/attrs';

export const onRequest = async (_context, next) => {
    const response = await next();
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
        return response;
    }

    const html = await response.text();
    if (!/<head[\s>]/i.test(html)) {
        return new Response(html, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    const injected = html.includes(scriptTag)
        ? html
        : html.replace(/(<head[^>]*>)/i, `$1\n    ${scriptTag}`);

    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(injected, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
};
