import type { Plugin } from "vite";

/**
 * Dev server only: `/dev/wait?ms=4000` answers with an empty image after the
 * given delay. The harness loads it to hold back the page's load event, so a
 * headless browser screenshots a scenario after it has settled.
 */
export const waitEndpoint = (): Plugin => ({
  name: "harness-wait",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/dev/wait", (request, response) => {
      const url = new URL(request.url ?? "", "http://localhost");
      const delay = Math.min(Number(url.searchParams.get("ms")) || 0, 15_000);
      setTimeout(() => {
        response.setHeader("Content-Type", "image/svg+xml");
        response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
      }, delay);
    });
  },
});
