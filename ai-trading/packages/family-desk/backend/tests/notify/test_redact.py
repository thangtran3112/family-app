from ai_trading.notify.redact import redact


def test_redact_replaces_an_explicit_secret():
    out = redact("error talking to https://example.com/x?a=hunter2hunter2", "hunter2hunter2")
    assert "hunter2hunter2" not in out
    assert "[redacted]" in out


def test_redact_is_safe_with_no_secrets():
    assert redact("plain text, nothing to hide") == "plain text, nothing to hide"


def test_redact_ignores_empty_secret_strings():
    assert redact("hello world", "", "") == "hello world"


def test_redact_strips_a_bot_token_shaped_telegram_url_segment_even_unnamed():
    text = "POST https://api.telegram.org/bot123456789:AAFakeTokenValueNotReal00000/sendMessage failed"
    out = redact(text)
    assert "123456789:AAFakeTokenValueNotReal00000" not in out
    assert "/bot[redacted]/" in out


def test_redact_strips_a_token_query_parameter_even_unnamed():
    out = redact("GET https://example.com/webhook?token=abc123SECRET&chat_id=5 timed out")
    assert "abc123SECRET" not in out
    assert "token=[redacted]" in out


def test_redact_strips_a_webhook_looking_parameter_even_unnamed():
    out = redact("bad request: webhook_url=https://example.test/webhook/FAKE-SECRET-1")
    assert "SECRETSECRET" not in out
    assert "webhook_url=[redacted]" in out


def test_redact_strips_a_key_parameter_case_insensitively():
    out = redact("401 Unauthorized: API_KEY=supersecretvalue rejected")
    assert "supersecretvalue" not in out
    assert "[redacted]" in out


def test_redact_combines_explicit_secret_with_defense_in_depth_pass():
    text = "https://api.telegram.org/botMYSECRETTOKEN/sendMessage?token=MYSECRETTOKEN failed"
    out = redact(text, "MYSECRETTOKEN")
    assert "MYSECRETTOKEN" not in out
