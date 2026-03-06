import { addEntry } from "@universal-deploy/store";
import type { Plugin } from "vite";

/** Wraps vike/server's renderPage() into a `{ fetch }` handler for @universal-deploy/store. */
const VIKE_HANDLER_ID = "virtual:edgeone:vike-handler";
const RESOLVED_VIKE_HANDLER_ID = "\0virtual:edgeone:vike-handler";

const VIKE_HANDLER_CODE = /* js */ `
import { renderPage } from 'vike/server';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    const pageContext = await renderPage({
      urlOriginal: url.pathname + url.search,
      headersOriginal: Object.fromEntries(request.headers.entries()),
    });

    if (!pageContext.httpResponse) {
      return new Response('Not Found', { status: 404 });
    }

    const { statusCode, headers } = pageContext.httpResponse;

    const responseHeaders = new Headers();
    for (const [name, value] of headers) {
      responseHeaders.append(name, value);
    }

    const body =
      typeof pageContext.httpResponse.getReadableWebStream === 'function'
        ? pageContext.httpResponse.getReadableWebStream()
        : pageContext.httpResponse.body;

    return new Response(body, {
      status: statusCode,
      headers: responseHeaders,
    });
  },
};
`.trimStart();

/** Vike adapter plugin: registers the virtual handler as a catch-all server entry. */
export function createVikeHandlerPlugin(): Plugin {
  return {
    name: "edgeone:vike-handler",

    config: {
      order: "pre",
      handler() {
        addEntry({
          id: VIKE_HANDLER_ID,
          route: "/**",
        });
      },
    },

    resolveId(id) {
      if (
        id === VIKE_HANDLER_ID ||
        id === `${VIKE_HANDLER_ID}?default` ||
        id === RESOLVED_VIKE_HANDLER_ID ||
        id === `${RESOLVED_VIKE_HANDLER_ID}?default`
      ) {
        return RESOLVED_VIKE_HANDLER_ID;
      }
    },

    load(id) {
      if (
        id === RESOLVED_VIKE_HANDLER_ID ||
        id === `${RESOLVED_VIKE_HANDLER_ID}?default`
      ) {
        return VIKE_HANDLER_CODE;
      }
    },
  };
}
