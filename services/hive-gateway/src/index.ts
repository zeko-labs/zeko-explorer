export default {
  fetch(_request: Request, env: Env): Response {
    return Response.json({
      component: "hive-gateway",
      status: "ok",
      upstreams: {
        explorer: env.EXPLORER_API_URL,
        bridge: env.BRIDGE_API_URL,
        contractRegistry: env.CONTRACT_REGISTRY_API_URL,
      },
    });
  },
};
