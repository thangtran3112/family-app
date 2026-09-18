"""Enrichment workflow activities.

Privacy boundary: NO ExpenseEnrichmentInputV1 or ExpenseEnrichmentResultV1
ever appear in activity signatures or return types. These models live entirely
inside enrichment_process's implementation; they never cross the
Temporal serialization (workflow history) boundary.

Activity names registered:
  - enrichment_mark_running  (separate from OCR's mark_running to avoid collision)
  - enrichment_process       (GET input + evaluate/bypass + POST result -- all in one)
  - enrichment_mark_failed   (terminal failure callback)
"""

from __future__ import annotations

import httpx
from expense_contracts.generated import (
    ExpenseEnrichmentInputV1,
    JobStatusUpdateRequestV1,
)
from temporalio import activity
from temporalio.exceptions import ApplicationError

from ai_worker.app_api_client import (
    AppApiClient,
    EnrichmentInputClient,
    EnrichmentResultClient,
)
from ai_worker.enrichment import evaluate


class EnrichmentActivities:
    """Enrichment pipeline activities.

    Three clients with separate M2M scopes:
    - ocr_status_client  (jobs:write + files:read) -- for mark_running / mark_failed
    - input_client       (jobs:enrichment-input)   -- GET enrichment-input only
    - result_client      (jobs:enrichment-result)  -- POST enrichment-result only
    """

    def __init__(
        self,
        ocr_status_client: AppApiClient,
        input_client: EnrichmentInputClient,
        result_client: EnrichmentResultClient,
    ) -> None:
        self._ocr_status_client = ocr_status_client
        self._input_client = input_client
        self._result_client = result_client

    @activity.defn(name="enrichment_mark_running")
    async def enrichment_mark_running(self, job_id: str) -> int:
        """POST status=RUNNING for the enrichment job.

        Uses the existing jobs:write client. Returns the new version so the
        workflow can chain expectedJobVersion into the process activity.
        Input type: plain str (jobId only). No enrichment models in history.
        """
        return await self._ocr_status_client.update_status(
            job_id,
            JobStatusUpdateRequestV1(
                schemaVersion=1,
                status="RUNNING",
                idempotencyKey=f"{job_id}:enrichment:status:running",
                expectedJobVersion=2,  # DISPATCHED_JOB_VERSION; passed from caller via workflow
            ),
        )

    @activity.defn(name="enrichment_process")
    async def enrichment_process(self, job_id: str, running_version: int) -> str:
        """GET enrichment input, evaluate or bypass, POST result.

        ALL customer facts (ExpenseEnrichmentInputV1, ExpenseEnrichmentResultV1)
        are confined to this function body. The activity signature carries only
        primitive types (str, int) so Temporal never serialises the enrichment
        models to workflow history.

        Returns the outcome string ("applied", "stale", or "skipped") as an
        opaque token for the workflow to log/branch on. The new job version is
        not returned here -- the workflow does not need it after submission
        (no subsequent enrichment callbacks require it).

        Raises ApplicationError(non_retryable=True) on permanent 4xx so the
        RetryPolicy(maximum_attempts=5) fails fast without consuming retries.
        """
        try:
            raw = await self._input_client.get_enrichment_input(job_id)
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if 400 <= status < 500 and status not in {408, 429}:
                raise ApplicationError(
                    f"Enrichment input GET rejected with HTTP {status}",
                    type="EnrichmentInputNonRetryable",
                    non_retryable=True,
                ) from exc
            raise

        outcome = raw.get("outcome")

        if outcome in {"stale", "skipped"}:
            # Bypass evaluator: construct empty successful result directly.
            result_payload = {
                "schemaVersion": 1,
                "rulesVersion": 1,
                "outcome": outcome,
                "ruleTagKeys": [],
                "suggestions": [],
            }
        elif outcome == "evaluate":
            # Parse the input through the generated model (stays here, never serialised).
            inp = ExpenseEnrichmentInputV1.model_validate(raw["input"])
            enrichment_result = evaluate(inp)
            result_payload = enrichment_result.model_dump(mode="json")
        else:
            raise ApplicationError(
                f"Unexpected enrichment input outcome: {outcome!r}",
                type="EnrichmentInputUnexpectedOutcome",
                non_retryable=True,
            )

        idempotency_key = f"{job_id}:enrichment:result:v1"
        try:
            await self._result_client.submit_enrichment_result(
                job_id=job_id,
                expected_job_version=running_version,
                idempotency_key=idempotency_key,
                result=result_payload,
            )
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if 400 <= status < 500 and status not in {408, 429}:
                raise ApplicationError(
                    f"Enrichment result POST rejected with HTTP {status}",
                    type="EnrichmentResultNonRetryable",
                    non_retryable=True,
                ) from exc
            raise

        return str(outcome)

    @activity.defn(name="enrichment_mark_failed")
    async def enrichment_mark_failed(self, job_id: str, running_version: int) -> int:
        """POST status=FAILED for the enrichment job.

        Terminal best-effort callback. Uses the jobs:write client.
        Returns the new version (for symmetry with mark_running), but the
        workflow ignores it after a FAILED transition.
        """
        return await self._ocr_status_client.update_status(
            job_id,
            JobStatusUpdateRequestV1(
                schemaVersion=1,
                status="FAILED",
                idempotencyKey=f"{job_id}:enrichment:status:failed",
                expectedJobVersion=running_version,
                message="ENRICHMENT_FAILED: inference or transport error",
            ),
        )
