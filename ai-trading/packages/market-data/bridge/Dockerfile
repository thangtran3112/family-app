# syntax=docker/dockerfile:1.7
# Static Go binary on distroless. The container healthcheck is `bridge healthcheck`
# (the image has no shell, curl, or wget).
ARG GO_IMAGE=golang:1.27-trixie@sha256:c65ecfe613b539ac74c62a4c3b2c27e8f8a6076384c8f27e8a3c0f3be17cc385
ARG RUNTIME_IMAGE=gcr.io/distroless/static-debian13:nonroot@sha256:18f4cc26c9ffa7f20a359298be7deadac5c607c8e03a02b8119f1a5fc2f82c99

FROM ${GO_IMAGE} AS build
ARG BUILD_REVISION=dev
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-trimpath GOTOOLCHAIN=local
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -ldflags "-s -w -X main.build=${BUILD_REVISION}" -o /out/bridge ./cmd/bridge

FROM ${RUNTIME_IMAGE}
COPY --from=build /out/bridge /bridge
USER nonroot:nonroot
ENV BRIDGE_LISTEN=:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["/bridge", "healthcheck"]
ENTRYPOINT ["/bridge"]
CMD ["--role=bridge"]
