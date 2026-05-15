FROM debian:trixie-slim AS base
WORKDIR /app

ENV PROTO_HOME=/root/.proto
ENV PATH="${PROTO_HOME}/shims:${PROTO_HOME}/bin:/root/.moon/bin:${PATH}"
ENV CI=true
ENV LEFTHOOK=0

RUN apt-get update \
  && apt-get install --yes --no-install-recommends bash ca-certificates curl git libatomic1 tar xz-utils \
  && rm -rf /var/lib/apt/lists/*

COPY .prototools ./
RUN curl -fsSL https://moonrepo.dev/install/proto.sh | bash -s -- --yes \
  && proto install node \
  && proto install pnpm \
  && proto install moon

FROM base AS skeleton
COPY . .
RUN moon docker scaffold bridge-api

FROM base AS build
COPY --from=skeleton /app/.moon/docker/configs .
COPY --from=skeleton /app/.prototools ./.prototools
COPY --from=skeleton /app/tsconfig.base.json ./tsconfig.base.json
RUN moon docker setup
COPY --from=skeleton /app/.moon/docker/sources .
RUN moon run bridge-api:build
RUN moon docker prune

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=4102
EXPOSE 4102
COPY --from=build /app /app
CMD ["node", "services/bridge-api/dist/index.mjs"]
