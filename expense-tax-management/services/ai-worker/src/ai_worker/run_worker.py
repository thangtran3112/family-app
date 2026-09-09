from __future__ import annotations

import asyncio
import os

from temporalio.client import Client
from temporalio.contrib.pydantic import pydantic_data_converter
from temporalio.worker import Worker

from ai_worker.activities import FoundationEchoActivities
from ai_worker.app_api_client import app_api_client_from_env
from ai_worker.constants import TASK_QUEUE
from ai_worker.workflows import FoundationEchoWorkflow


async def main() -> None:
    address = os.environ.get("TEMPORAL_HOST", "127.0.0.1:7233")
    namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    task_queue = os.environ.get("AI_WORKER_TASK_QUEUE", TASK_QUEUE)

    client = await Client.connect(
        address,
        namespace=namespace,
        data_converter=pydantic_data_converter,
    )
    activities = FoundationEchoActivities(app_api_client_from_env())
    worker = Worker(
        client,
        task_queue=task_queue,
        workflows=[FoundationEchoWorkflow],
        activities=[activities.mark_running, activities.submit_echo_result],
    )
    print(
        f"ai-worker: polling task queue '{task_queue}' at {address} ({namespace})",
        flush=True,
    )
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
