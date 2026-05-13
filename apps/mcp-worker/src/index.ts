export interface Env {
  readonly HIVE_GATEWAY_URL: string;
}

export default {
  fetch(_request: Request, env: Env): Response {
    return Response.json({
      component: "mcp-worker",
      status: "ok",
      gateway: env.HIVE_GATEWAY_URL,
    });
  },
};
