import pytest

from ai_worker.config import WorkerConfig, worker_config_from_env

ENV = {
    "CLERK_ISSUER_URL": " https://clerk.test ",
    "CLERK_JWKS_URL": " https://clerk.test/.well-known/jwks.json ",
    "CLERK_TENANT_AUDIENCE": " tenant-audience ",
    "CLERK_PLATFORM_AUDIENCE": " platform-audience ",
    "CLERK_APP_SERVICE_AUDIENCE": " app-service-audience ",
    "CLERK_FOUNDRY_SERVICE_AUDIENCE": " foundry-service-audience ",
    "CLERK_MACHINE_SECRET_KEY": " ak_test_machine_secret ",
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY": " pk_test_fake ",
    "CLERK_SECRET_KEY": " sk_test_fake ",
    "CLERK_WEBHOOK_SIGNING_SECRET": " whsec_test_fake ",
}


def test_worker_config_parses_clerk_values_without_logging_secrets():
    config = worker_config_from_env(ENV)

    assert isinstance(config, WorkerConfig)
    assert config.clerk.issuer_url == "https://clerk.test"
    assert config.clerk.jwks_url == "https://clerk.test/.well-known/jwks.json"
    assert config.clerk.tenant_audience == "tenant-audience"
    assert config.clerk.platform_audience == "platform-audience"
    assert config.clerk.app_service_audience == "app-service-audience"
    assert config.clerk.foundry_service_audience == "foundry-service-audience"
    assert config.clerk.machine_secret_key == "ak_test_machine_secret"
    assert config.clerk.publishable_key == "pk_test_fake"
    assert config.clerk.secret_key == "sk_test_fake"
    assert config.clerk.webhook_signing_secret == "whsec_test_fake"
    assert "sk_test_fake" not in repr(config)


@pytest.mark.parametrize(
    "key, value",
    [
        ("CLERK_ISSUER_URL", "https://clerk.test"),
        ("CLERK_JWKS_URL", "https://clerk.test/.well-known/jwks.json"),
        ("CLERK_TENANT_AUDIENCE", "tenant-audience"),
        ("CLERK_PLATFORM_AUDIENCE", "platform-audience"),
        ("CLERK_APP_SERVICE_AUDIENCE", "app-service-audience"),
        ("CLERK_FOUNDRY_SERVICE_AUDIENCE", "foundry-service-audience"),
        ("CLERK_MACHINE_SECRET_KEY", "ak_test_machine_secret"),
    ],
)
def test_worker_config_reports_missing_clerk_variable(key, value):
    env = dict(ENV)
    del env[key]

    with pytest.raises(ValueError, match=f"Missing required environment variable: {key}"):
        worker_config_from_env(env)


def test_worker_config_rejects_invalid_url():
    env = {**ENV, "CLERK_JWKS_URL": "not-a-url"}

    with pytest.raises(ValueError, match="Invalid URL in environment variable: CLERK_JWKS_URL"):
        worker_config_from_env(env)


@pytest.mark.parametrize(
    "key, value",
    [
        ("CLERK_ISSUER_URL", "file:///tmp/issuer"),
        ("CLERK_ISSUER_URL", "data:text/plain,issuer"),
        ("CLERK_ISSUER_URL", "http://clerk.test"),
        ("CLERK_JWKS_URL", "file:///tmp/jwks.json"),
        ("CLERK_JWKS_URL", "data:application/json,{}"),
        ("CLERK_JWKS_URL", "http://clerk.test/jwks"),
    ],
)
def test_worker_config_rejects_non_https_urls(key, value):
    env = {**ENV, key: value}

    with pytest.raises(ValueError, match=f"Invalid URL in environment variable: {key}"):
        worker_config_from_env(env)


def test_worker_config_allows_optional_secrets_to_be_absent():
    env = dict(ENV)
    env.pop("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")
    env.pop("CLERK_SECRET_KEY")
    env.pop("CLERK_WEBHOOK_SIGNING_SECRET")

    config = worker_config_from_env(env)

    assert config.clerk.publishable_key is None
    assert config.clerk.secret_key is None
    assert config.clerk.webhook_signing_secret is None
