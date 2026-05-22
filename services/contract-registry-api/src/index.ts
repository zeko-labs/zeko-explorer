export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    if (!key) {
      return Response.json({
        component: "contract-registry-api",
        status: "ok",
        binding: "CONTRACT_SCHEMAS",
      });
    }

    const value = await env.CONTRACT_SCHEMAS.get(key, "json");
    return Response.json({ key, value });
  },
};
