"""Worker simples: roda o job de agendamentos em loop.

Alternativa ao cron quando você está em Docker.
"""

from __future__ import annotations

import time

from jobs.cron_run_due import main as run_due
from jobs.worker_deliveries import process_once as process_deliveries


def main() -> None:
    while True:
        try:
            run_due()
        except Exception as e:
            print({"worker_error": str(e)})

        try:
            process_deliveries(batch=50)
        except Exception as e:
            print({"deliveries_worker_error": str(e)})

        time.sleep(60)


if __name__ == "__main__":
    main()
