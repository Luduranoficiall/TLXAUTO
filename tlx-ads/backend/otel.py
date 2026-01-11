import os
import importlib


def setup_otel(app) -> None:
    """Instrumenta FastAPI/requests e exporta spans via OTLP/HTTP.

    Ativa somente se OTEL_EXPORTER_OTLP_ENDPOINT estiver definido.
    """

    endpoint = (os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT") or "").strip()
    if not endpoint:
        return

    service_name = os.getenv("OTEL_SERVICE_NAME", "tlxauto-ads")

    # Imports atrasados para manter o custo zero quando OTel estiver desativado
    trace = importlib.import_module("opentelemetry.trace")
    Resource = getattr(importlib.import_module("opentelemetry.sdk.resources"), "Resource")
    TracerProvider = getattr(importlib.import_module("opentelemetry.sdk.trace"), "TracerProvider")
    BatchSpanProcessor = getattr(importlib.import_module("opentelemetry.sdk.trace.export"), "BatchSpanProcessor")
    OTLPSpanExporter = getattr(
        importlib.import_module("opentelemetry.exporter.otlp.proto.http.trace_exporter"),
        "OTLPSpanExporter",
    )
    FastAPIInstrumentor = getattr(importlib.import_module("opentelemetry.instrumentation.fastapi"), "FastAPIInstrumentor")
    RequestsInstrumentor = getattr(importlib.import_module("opentelemetry.instrumentation.requests"), "RequestsInstrumentor")

    resource = Resource.create({"service.name": service_name})
    provider = TracerProvider(resource=resource)
    trace.set_tracer_provider(provider)

    exporter = OTLPSpanExporter(endpoint=endpoint)
    provider.add_span_processor(BatchSpanProcessor(exporter))

    FastAPIInstrumentor.instrument_app(app)
    RequestsInstrumentor().instrument()
