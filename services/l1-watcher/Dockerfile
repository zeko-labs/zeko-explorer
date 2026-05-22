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

FROM base AS build
COPY ./.moon/docker/configs .
COPY .prototools ./.prototools
RUN moon docker setup
COPY ./.moon/docker/sources .
RUN moon run l1-watcher:build
RUN moon docker prune

FROM node:26.1.0-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
CMD ["node", "services/l1-watcher/dist/index.mjs"]
