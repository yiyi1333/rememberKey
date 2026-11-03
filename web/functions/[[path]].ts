import { proxyRequest, type PagesEnv } from '../cloudflare/proxy';

export const onRequest: PagesFunction<PagesEnv> = ({ request, env }) => proxyRequest(request, env);
