FROM node:22-alpine AS web

WORKDIR /web

COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY web/ ./
# vite.config.ts points outDir outside the frontend root, at /internal/web/dist.
RUN npm run build

FROM golang:1.26-alpine AS builder

WORKDIR /src

RUN apk add --no-cache ca-certificates tzdata

COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download

COPY . .
# The bundle is embedded by internal/web, so it must exist before the Go build.
COPY --from=web /internal/web/dist /src/internal/web/dist

RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags "-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot

WORKDIR /app

COPY --from=builder /out/server /app/server
COPY --from=builder /src/configs /app/configs

ENV SHELF_CONFIG_PATH=/app/configs/config.yaml

EXPOSE 8080

USER nonroot:nonroot

ENTRYPOINT ["/app/server"]
