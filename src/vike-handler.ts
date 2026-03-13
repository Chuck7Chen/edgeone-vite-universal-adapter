import { addEntry } from "@universal-deploy/store";
import type { Plugin } from "vite";

/**
 * Virtual module that wraps `vike/server`'s `renderPage()` into a `{ fetch }` Fetchable
 * and registers it with the store via `addEntry()` (Vike doesn't do either on its own).
 */
const VIKE_HANDLER_ID = "virtual:edgeone:vike-handler";
const RESOLVED_VIKE_HANDLER_ID = "\0virtual:edgeone:vike-handler";

const VIKE_HANDLER_CODE = /* js */ `
import { renderPage } from 'vike/server';

export default {
  async fetch(request) {
    const pageContext = await renderPage({ urlOriginal: request.url, headersOriginal: request.headers });
    const { httpResponse } = pageContext;
    if (!httpResponse) {
      return new Response('Not Found', { status: 404 });
    }

    const { statusCode, headers } = httpResponse;

    // vike-react uses renderToPipeableStream (Node.js Stream Pipe),
    // so getReadableWebStream() throws. Use pipe() with a TransformStream
    // bridge to produce a Web ReadableStream that works in all cases.
    const { readable, writable } = new TransformStream();
    httpResponse.pipe(writable);

    return new Response(readable, { status: statusCode, headers });
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
