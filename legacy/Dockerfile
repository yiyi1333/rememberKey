# syntax=docker/dockerfile:1.7
FROM node:22.14.0-alpine3.21 AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.23.12-alpine3.22 AS server-build
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/rememberkey .

FROM alpine:3.22.1 AS runtime
RUN apk add --no-cache ca-certificates && addgroup -S -g 10001 rememberkey && adduser -S -D -H -u 10001 -G rememberkey rememberkey
WORKDIR /app
COPY --from=server-build /out/rememberkey /app/rememberkey
COPY --from=web-build /src/web/dist /app/web
ENV RK_WEB_DIR=/app/web RK_DEV=false
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/readyz || exit 1
ENTRYPOINT ["/app/rememberkey"]
