from __future__ import annotations

import enum


class ExpenseSource(str, enum.Enum):
    MANUAL = "MANUAL"
    EMAIL = "EMAIL"
    MANUAL_AND_EMAIL = "MANUAL_AND_EMAIL"


class ExpenseStatus(str, enum.Enum):
    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    REVIEW = "REVIEW"
    COMPLETED = "COMPLETED"
    DUPLICATE = "DUPLICATE"
    ERROR = "ERROR"


class TaxDeductionType(str, enum.Enum):
    BUSINESS = "BUSINESS"
    HOME_OFFICE = "HOME_OFFICE"
    VEHICLE = "VEHICLE"
    MIXED = "MIXED"
    NONE = "NONE"
