import pytest
from expense_contracts.generated import OcrExtractionResultV1

from ai_worker.providers.fake_ocr import extract_receipt


def test_fake_extraction_returns_a_contract_valid_payload():
    payload = OcrExtractionResultV1(**extract_receipt(b"%PDF-1.4 fake"))
    assert payload.merchant == "Fake OCR Merchant"
    assert payload.amount == "12.34"
    assert payload.currency == "USD"
    assert payload.confidence == 1.0


def test_fake_extraction_refuses_empty_input():
    with pytest.raises(ValueError):
        extract_receipt(b"")
