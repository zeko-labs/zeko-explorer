export default defineNuxtConfig({
  compatibilityDate: "2026-05-13",
  devtools: { enabled: true },
  modules: [],
  nitro: {
    preset: "cloudflare-pages",
  },
  ssr: false,
  runtimeConfig: {
    public: {
      gatewayUrl: process.env.NUXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8787/graphql",
    },
  },
});
